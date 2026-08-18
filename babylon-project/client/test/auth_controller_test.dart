import 'dart:async';

import 'package:babylon_client/src/api_client.dart';
import 'package:babylon_client/src/auth_controller.dart';
import 'package:babylon_client/src/native_auth.dart';
import 'package:flutter_test/flutter_test.dart';

import 'fakes.dart';

void main() {
  late FakeGateway gateway;
  late FakeBrowser browser;
  late FakeCallback callback;
  late AuthController controller;

  setUp(() {
    gateway = FakeGateway();
    browser = FakeBrowser();
    callback = FakeCallback();
    controller = AuthController(
      api: gateway,
      browser: browser,
      callbackFactory: () => callback,
      secureValues: MemoryStore(),
    );
  });

  test('reports an unavailable backend', () async {
    gateway.healthy = false;
    await controller.initialize();
    expect(controller.stage, AuthStage.unavailable);
  });

  test('shows signed-out state without an existing session', () async {
    await controller.initialize();
    expect(controller.stage, AuthStage.signedOut);
  });

  test('does not report signed-out when session restoration loses the network', () async {
    gateway.authenticated = true;
    gateway.meFailure = BabylonApiException(
      0,
      'NETWORK_UNAVAILABLE',
      'A hálózat nem érhető el.',
    );

    await controller.initialize();

    expect(controller.stage, AuthStage.unavailable);
    expect(controller.error, 'A hálózat nem érhető el.');
  });

  test('invitation flow waits for e-mail then exchanges the callback', () async {
    await controller.initialize();
    await controller.acceptInvitation('User@Example.Test', 'invite-code');
    expect(controller.stage, AuthStage.waitingForEmail);
    expect(gateway.acceptCalls, 1);
    final expectedState = Uri.parse(
      (await gateway.startNativeAuth(
            operation: 'register',
            pkceChallenge: 'x',
            state: 'ignored',
          ))['browserUrl']
          as String,
    ).fragment;
    expect(expectedState, isNotEmpty);
    callback.completer.complete(
      const NativeCallback(code: 'code', state: 'wrong'),
    );
    await Future<void>.delayed(Duration.zero);
    expect(controller.stage, AuthStage.signedOut);
    expect(controller.error, isNotNull);
    await controller.resendEmail();
    expect(gateway.resendCalls, 0);
  });

  test(
    'failed invitation acceptance closes the loopback callback server',
    () async {
      gateway.failAccept = true;
      await controller.acceptInvitation('user@example.test', 'wrong-code');
      expect(callback.closed, isTrue);
      expect(callback.completer.isCompleted, isTrue);
      expect(controller.error, 'Hibás meghívó');
    },
  );

  test('logout clears pending onboarding secrets from memory', () async {
    await controller.acceptInvitation('user@example.test', 'invite-code');
    expect(controller.stage, AuthStage.waitingForEmail);

    await controller.logout();
    await controller.resendEmail();

    expect(gateway.resendCalls, 0);
    expect(controller.stage, AuthStage.signedOut);
  });

  test('cancelling an e-mail flow closes its callback and clears its secrets', () async {
    await controller.acceptInvitation('user@example.test', 'invite-code');

    await controller.cancelAuthenticationFlow();
    await Future<void>.delayed(Duration.zero);
    await controller.resendEmail();

    expect(callback.closed, isTrue);
    expect(gateway.resendCalls, 0);
    expect(controller.stage, AuthStage.signedOut);
  });

  test(
    'successful exchange clears onboarding secrets and preserves unavailable state if profile loading fails',
    () async {
      gateway.meFailure = BabylonApiException(
        0,
        'NETWORK_UNAVAILABLE',
        'A hálózat nem érhető el.',
      );
      await controller.acceptInvitation('user@example.test', 'invite-code');
      callback.completer.complete(
        NativeCallback(code: 'return-code', state: gateway.lastState!),
      );
      await Future<void>.delayed(Duration.zero);
      await Future<void>.delayed(Duration.zero);
      await controller.resendEmail();

      expect(gateway.exchanges, 1);
      expect(controller.stage, AuthStage.unavailable);
      expect(controller.error, 'A hálózat nem érhető el.');
      expect(gateway.resendCalls, 0);
    },
  );

  test('cancelling during exchange revokes the stale session and cannot sign in', () async {
    gateway.exchangeGate = Completer<void>();
    await controller.acceptInvitation('user@example.test', 'invite-code');
    callback.completer.complete(
      NativeCallback(code: 'return-code', state: gateway.lastState!),
    );
    await gateway.exchangeStarted.future;

    final cancellation = controller.cancelAuthenticationFlow();
    gateway.exchangeGate!.complete();
    await cancellation;

    expect(gateway.exchanges, 1);
    expect(gateway.logoutCalls, 1);
    expect(gateway.authenticated, isFalse);
    expect(controller.stage, AuthStage.signedOut);
    expect(controller.profile, isNull);
  });

  test('starting a replacement flow waits for old cancellation and keeps new secrets', () async {
    await controller.acceptInvitation('old@example.test', 'old-code');
    final oldCallback = callback;
    final newCallback = FakeCallback();
    callback = newCallback;

    await controller.acceptInvitation('new@example.test', 'new-code');
    await controller.resendEmail();

    expect(oldCallback.closed, isTrue);
    expect(oldCallback.completer.isCompleted, isTrue);
    expect(newCallback.closed, isFalse);
    expect(gateway.acceptCalls, 2);
    expect(gateway.resendCalls, 1);
    expect(controller.stage, AuthStage.waitingForEmail);
  });

  test(
    'passkey login launches the system browser and creates a signed-in state',
    () async {
      gateway.authenticated = false;
      await controller.signIn();
      final opened = browser.opened!;
      final expectedState = Uri.splitQueryString(opened.fragment)['state']!;
      callback.completer.complete(
        NativeCallback(code: 'return-code', state: expectedState),
      );
      await Future<void>.delayed(Duration.zero);
      await Future<void>.delayed(Duration.zero);
      expect(gateway.exchanges, 1);
      expect(controller.stage, AuthStage.signedIn);
      expect(controller.deviceList, hasLength(1));
    },
  );

  test('serializes replacement flows until the first invitation mutation finishes', () async {
    gateway.acceptGate = Completer<void>();
    final first = controller.acceptInvitation('old@example.test', 'old-code');
    await gateway.acceptStarted.future;
    final oldCallback = callback;
    final newCallback = FakeCallback();
    callback = newCallback;

    final second = controller.acceptInvitation('new@example.test', 'new-code');
    await Future<void>.delayed(Duration.zero);
    expect(gateway.acceptCalls, 1);

    gateway.acceptGate!.complete();
    await first;
    await second;

    expect(gateway.acceptCalls, 2);
    expect(oldCallback.closed, isTrue);
    expect(newCallback.closed, isFalse);
    expect(controller.stage, AuthStage.waitingForEmail);
  });

  test('revoking the current device immediately signs out', () async {
    gateway.authenticated = true;
    await controller.initialize();
    await controller.revokeDevice('device-1');
    expect(controller.stage, AuthStage.signedOut);
  });
}
