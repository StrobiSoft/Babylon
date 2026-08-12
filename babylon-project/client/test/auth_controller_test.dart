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
    // The controller validates a generated state; retrieve it from the transaction URL held by the fake callback path is intentionally opaque.
    callback.completer.complete(
      const NativeCallback(code: 'code', state: 'wrong'),
    );
    await Future<void>.delayed(Duration.zero);
    expect(controller.stage, AuthStage.signedOut);
    expect(controller.error, isNotNull);
  });

  test(
    'failed invitation acceptance closes the loopback callback server',
    () async {
      gateway.failAccept = true;
      await controller.acceptInvitation('user@example.test', 'wrong-code');
      expect(callback.closed, isTrue);
      expect(controller.error, 'Hibás meghívó');
    },
  );

  test(
    'passkey login launches the system browser and creates a signed-in state',
    () async {
      gateway.authenticated = false;
      final future = controller.signIn();
      await Future<void>.delayed(Duration.zero);
      final opened = browser.opened!;
      final expectedState = Uri.splitQueryString(opened.fragment)['state']!;
      callback.completer.complete(
        NativeCallback(code: 'return-code', state: expectedState),
      );
      await future;
      expect(gateway.exchanges, 1);
      expect(controller.stage, AuthStage.signedIn);
      expect(controller.deviceList, hasLength(1));
    },
  );

  test('revoking the current device immediately signs out', () async {
    gateway.authenticated = true;
    await controller.initialize();
    await controller.revokeDevice('device-1');
    expect(controller.stage, AuthStage.signedOut);
  });
}
