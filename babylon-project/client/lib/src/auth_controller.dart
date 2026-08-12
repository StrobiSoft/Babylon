import 'dart:io';

import 'package:flutter/foundation.dart';

import 'api_client.dart';
import 'native_auth.dart';
import 'token_store.dart';

enum AuthStage {
  checkingBackend,
  unavailable,
  signedOut,
  waitingForEmail,
  authenticating,
  signedIn,
}

class AuthController extends ChangeNotifier {
  AuthController({
    required this.api,
    required this.browser,
    required this.callbackFactory,
    required this.secureValues,
  });

  final BabylonGateway api;
  final BrowserLauncher browser;
  final CallbackReceiver Function() callbackFactory;
  final SecureValueStore secureValues;
  AuthStage stage = AuthStage.checkingBackend;
  String? error;
  Map<String, dynamic>? profile;
  List<Map<String, dynamic>> deviceList = [];
  String? _email;
  String? _transactionToken;
  String? _state;

  Future<void> initialize() async {
    stage = AuthStage.checkingBackend;
    notifyListeners();
    if (!await api.health()) {
      stage = AuthStage.unavailable;
      notifyListeners();
      return;
    }
    try {
      profile = await api.me();
      await loadDevices();
      stage = AuthStage.signedIn;
    } catch (_) {
      stage = AuthStage.signedOut;
    }
    notifyListeners();
  }

  Future<Map<String, String>> _beginNative(String operation) async {
    final verifier = randomBase64Url(48);
    final state = randomBase64Url();
    final transaction = await api.startNativeAuth(
      operation: operation,
      pkceChallenge: s256(verifier),
      state: state,
    );
    return {
      'verifier': verifier,
      'state': state,
      'transactionToken': transaction['transactionToken'] as String,
      'browserUrl': transaction['browserUrl'] as String,
    };
  }

  Future<String> _deviceKey() async {
    const key = 'babylon.client_device_key';
    final existing = await secureValues.read(key);
    if (existing != null) return existing;
    final created = randomBase64Url(48);
    await secureValues.write(key, created);
    return created;
  }

  Future<void> acceptInvitation(String email, String invitationCode) async {
    await _guard(() async {
      final flow = await _beginNative('register');
      _email = email.trim().toLowerCase();
      _transactionToken = flow['transactionToken'];
      _state = flow['state'];
      final callback = callbackFactory();
      final callbackFuture = callback.start();
      try {
        await api.acceptInvitation(
          email: _email!,
          invitationCode: invitationCode.trim(),
          transactionToken: _transactionToken!,
          state: _state!,
        );
      } catch (_) {
        await callback.close();
        rethrow;
      }
      stage = AuthStage.waitingForEmail;
      notifyListeners();
      _completeBrowserFlow(callbackFuture, flow['verifier']!, _state!);
    });
  }

  Future<void> resendEmail() async {
    if (_email == null || _transactionToken == null || _state == null) return;
    await _guard(
      () => api.resendVerification(
        email: _email!,
        transactionToken: _transactionToken!,
        state: _state!,
      ),
    );
  }

  Future<void> resume(String email) async {
    await _guard(() async {
      final flow = await _beginNative('register');
      _email = email.trim().toLowerCase();
      _transactionToken = flow['transactionToken'];
      _state = flow['state'];
      final callback = callbackFactory();
      final callbackFuture = callback.start();
      try {
        await api.resumeOnboarding(
          email: _email!,
          transactionToken: _transactionToken!,
          state: _state!,
        );
      } catch (_) {
        await callback.close();
        rethrow;
      }
      stage = AuthStage.waitingForEmail;
      notifyListeners();
      _completeBrowserFlow(callbackFuture, flow['verifier']!, _state!);
    });
  }

  Future<void> signIn() async {
    await _guard(() async {
      final flow = await _beginNative('authenticate');
      final callback = callbackFactory();
      final callbackFuture = callback.start();
      stage = AuthStage.authenticating;
      notifyListeners();
      if (!await browser.open(Uri.parse(flow['browserUrl']!))) {
        await callback.close();
        throw StateError('A rendszerböngésző nem indítható el.');
      }
      await _exchange(await callbackFuture, flow['verifier']!, flow['state']!);
    });
  }

  void _completeBrowserFlow(
    Future<NativeCallback> future,
    String verifier,
    String state,
  ) {
    future.then((callback) => _exchange(callback, verifier, state)).catchError((
      Object failure,
    ) {
      error = failure.toString();
      stage = AuthStage.signedOut;
      notifyListeners();
    });
  }

  Future<void> _exchange(
    NativeCallback callback,
    String verifier,
    String expectedState,
  ) async {
    if (callback.state != expectedState) {
      throw StateError('A visszatérési state nem egyezik.');
    }
    stage = AuthStage.authenticating;
    notifyListeners();
    await api.exchange(
      returnCode: callback.code,
      pkceVerifier: verifier,
      state: callback.state,
      deviceName: Platform.isWindows ? 'Babylon Windows' : 'Babylon Android',
      platform: Platform.isWindows ? 'windows' : 'android',
      clientDeviceKey: await _deviceKey(),
    );
    profile = await api.me();
    await loadDevices();
    stage = AuthStage.signedIn;
    notifyListeners();
  }

  Future<void> loadDevices() async {
    deviceList = await api.devices();
    notifyListeners();
  }

  Future<void> renameDevice(String id, String name) async {
    await _guard(() async {
      await api.renameDevice(id, name);
      await loadDevices();
    });
  }

  Future<void> revokeDevice(String id) async {
    await _guard(() async {
      final current = deviceList.any(
        (item) => item['id'] == id && item['current'] == true,
      );
      await api.revokeDevice(id);
      if (current) {
        profile = null;
        deviceList = [];
        stage = AuthStage.signedOut;
      } else {
        await loadDevices();
      }
    });
  }

  Future<void> logout() async {
    await _guard(api.logout);
    profile = null;
    deviceList = [];
    stage = AuthStage.signedOut;
    notifyListeners();
  }

  Future<void> _guard(Future<void> Function() action) async {
    error = null;
    try {
      await action();
    } catch (failure) {
      error = failure is BabylonApiException
          ? failure.message
          : 'Váratlan hálózati vagy hitelesítési hiba.';
      if (stage == AuthStage.authenticating) stage = AuthStage.signedOut;
      notifyListeners();
    }
  }
}
