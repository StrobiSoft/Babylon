import 'dart:async';
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
  CallbackReceiver? _activeCallback;
  Future<NativeCallback>? _activeCallbackFuture;
  Future<void>? _activeFlowTask;
  Future<void> _initialFlowQueue = Future<void>.value();
  var _flowGeneration = 0;

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
    } on BabylonApiException catch (failure) {
      if (failure.statusCode == 401 || failure.statusCode == 403) {
        stage = AuthStage.signedOut;
      } else {
        error = failure.message;
        stage = AuthStage.unavailable;
      }
    } catch (_) {
      error = 'Váratlan hálózati vagy hitelesítési hiba.';
      stage = AuthStage.unavailable;
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

  Future<void> acceptInvitation(String email, String invitationCode) =>
      _enqueueInitialFlow(() => _acceptInvitation(email, invitationCode));

  Future<void> _acceptInvitation(String email, String invitationCode) async {
    await cancelAuthenticationFlow();
    final generation = ++_flowGeneration;
    await _guard(() async {
      stage = AuthStage.authenticating;
      notifyListeners();
      final flow = await _beginNative('register');
      if (!_isCurrentFlow(generation)) return;
      _email = email.trim().toLowerCase();
      _transactionToken = flow['transactionToken'];
      _state = flow['state'];
      final callback = callbackFactory();
      _activeCallback = callback;
      final callbackFuture = callback.start();
      _activeCallbackFuture = callbackFuture;
      try {
        await api.acceptInvitation(
          email: _email!,
          invitationCode: invitationCode.trim(),
          transactionToken: _transactionToken!,
          state: _state!,
        );
      } catch (_) {
        await _cancelAndObserve(callback, callbackFuture);
        if (!_isCurrentFlow(generation, callback)) return;
        _finishCurrentFlow(generation, callback);
        rethrow;
      }
      if (!_isCurrentFlow(generation, callback)) {
        await _cancelAndObserve(callback, callbackFuture);
        return;
      }
      stage = AuthStage.waitingForEmail;
      notifyListeners();
      _completeBrowserFlow(
        generation,
        callback,
        callbackFuture,
        flow['verifier']!,
        _state!,
      );
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

  Future<void> resume(String email) =>
      _enqueueInitialFlow(() => _resume(email));

  Future<void> _resume(String email) async {
    await cancelAuthenticationFlow();
    final generation = ++_flowGeneration;
    await _guard(() async {
      stage = AuthStage.authenticating;
      notifyListeners();
      final flow = await _beginNative('register');
      if (!_isCurrentFlow(generation)) return;
      _email = email.trim().toLowerCase();
      _transactionToken = flow['transactionToken'];
      _state = flow['state'];
      final callback = callbackFactory();
      _activeCallback = callback;
      final callbackFuture = callback.start();
      _activeCallbackFuture = callbackFuture;
      try {
        await api.resumeOnboarding(
          email: _email!,
          transactionToken: _transactionToken!,
          state: _state!,
        );
      } catch (_) {
        await _cancelAndObserve(callback, callbackFuture);
        if (!_isCurrentFlow(generation, callback)) return;
        _finishCurrentFlow(generation, callback);
        rethrow;
      }
      if (!_isCurrentFlow(generation, callback)) {
        await _cancelAndObserve(callback, callbackFuture);
        return;
      }
      stage = AuthStage.waitingForEmail;
      notifyListeners();
      _completeBrowserFlow(
        generation,
        callback,
        callbackFuture,
        flow['verifier']!,
        _state!,
      );
    });
  }

  Future<void> signIn() => _enqueueInitialFlow(_startSignIn);

  Future<void> _startSignIn() async {
    await cancelAuthenticationFlow();
    final generation = ++_flowGeneration;
    await _guard(() async {
      stage = AuthStage.authenticating;
      notifyListeners();
      final flow = await _beginNative('authenticate');
      if (!_isCurrentFlow(generation)) return;
      final callback = callbackFactory();
      _activeCallback = callback;
      final callbackFuture = callback.start();
      _activeCallbackFuture = callbackFuture;
      if (!await browser.open(Uri.parse(flow['browserUrl']!))) {
        await _cancelAndObserve(callback, callbackFuture);
        if (!_isCurrentFlow(generation, callback)) return;
        _finishCurrentFlow(generation, callback);
        throw StateError('A rendszerböngésző nem indítható el.');
      }
      if (!_isCurrentFlow(generation, callback)) return;
      _completeBrowserFlow(
        generation,
        callback,
        callbackFuture,
        flow['verifier']!,
        flow['state']!,
      );
    });
  }

  void _completeBrowserFlow(
    int generation,
    CallbackReceiver callback,
    Future<NativeCallback> future,
    String verifier,
    String state,
  ) {
    final task = _finishBrowserFlow(generation, callback, future, verifier, state);
    _activeFlowTask = task;
    unawaited(task);
  }

  Future<void> _finishBrowserFlow(
    int generation,
    CallbackReceiver receiver,
    Future<NativeCallback> future,
    String verifier,
    String state,
  ) async {
    try {
      final callback = await future;
      if (!_isCurrentFlow(generation, receiver)) return;
      await _exchange(generation, receiver, callback, verifier, state);
    } catch (failure) {
      if (!_isCurrentFlow(generation, receiver)) return;
      _clearOnboardingSecrets();
      error = failure.toString();
      stage = AuthStage.signedOut;
      notifyListeners();
    } finally {
      _finishCurrentFlow(generation, receiver);
    }
  }

  Future<void> _exchange(
    int generation,
    CallbackReceiver receiver,
    NativeCallback callback,
    String verifier,
    String expectedState,
  ) async {
    if (!_isCurrentFlow(generation, receiver)) return;
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
    if (!_isCurrentFlow(generation, receiver)) {
      await api.logout();
      return;
    }
    _clearOnboardingSecrets();
    try {
      final loadedProfile = await api.me();
      if (!_isCurrentFlow(generation, receiver)) {
        await api.logout();
        return;
      }
      final loadedDevices = await api.devices();
      if (!_isCurrentFlow(generation, receiver)) {
        await api.logout();
        return;
      }
      profile = loadedProfile;
      deviceList = loadedDevices;
      stage = AuthStage.signedIn;
      notifyListeners();
    } on BabylonApiException catch (failure) {
      if (!_isCurrentFlow(generation, receiver)) {
        await api.logout();
        return;
      }
      if (failure.statusCode == 401 || failure.statusCode == 403) rethrow;
      error = failure.message;
      stage = AuthStage.unavailable;
      notifyListeners();
    } catch (_) {
      if (!_isCurrentFlow(generation, receiver)) {
        await api.logout();
        return;
      }
      error = 'Váratlan hálózati vagy hitelesítési hiba.';
      stage = AuthStage.unavailable;
      notifyListeners();
    }
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
    _clearOnboardingSecrets();
    profile = null;
    deviceList = [];
    stage = AuthStage.signedOut;
    notifyListeners();
  }

  Future<void> cancelAuthenticationFlow() async {
    if (_activeCallback == null &&
        _activeFlowTask == null &&
        stage != AuthStage.waitingForEmail &&
        stage != AuthStage.authenticating) {
      return;
    }
    final callback = _activeCallback;
    final callbackFuture = _activeCallbackFuture;
    final task = _activeFlowTask;
    _flowGeneration += 1;
    _activeCallback = null;
    _activeCallbackFuture = null;
    _activeFlowTask = null;
    _clearOnboardingSecrets();
    error = null;
    stage = AuthStage.signedOut;
    notifyListeners();
    if (callback != null && callbackFuture != null) {
      await _cancelAndObserve(callback, callbackFuture);
    }
    if (task != null) await task;
  }

  Future<void> _enqueueInitialFlow(Future<void> Function() action) {
    final result = _initialFlowQueue.then((_) => action());
    _initialFlowQueue = result.then<void>((_) {}, onError: (Object _, StackTrace __) {});
    return result;
  }

  bool _isCurrentFlow(int generation, [CallbackReceiver? callback]) =>
      generation == _flowGeneration &&
      (callback == null || identical(_activeCallback, callback));

  Future<void> _cancelAndObserve(
    CallbackReceiver callback,
    Future<NativeCallback> future,
  ) async {
    final observed = future.then<void>(
      (_) {},
      onError: (Object _, StackTrace __) {},
    );
    try {
      await callback.cancel();
    } catch (_) {
      // The flow is already invalidated; continue draining its Future.
    }
    await observed;
  }

  void _finishCurrentFlow(int generation, CallbackReceiver callback) {
    if (!_isCurrentFlow(generation, callback)) return;
    _activeCallback = null;
    _activeCallbackFuture = null;
    _activeFlowTask = null;
    _clearOnboardingSecrets();
  }

  void _clearOnboardingSecrets() {
    _email = null;
    _transactionToken = null;
    _state = null;
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
