import 'dart:async';

import 'package:babylon_client/src/api_client.dart';
import 'package:babylon_client/src/native_auth.dart';
import 'package:babylon_client/src/token_store.dart';

class MemoryStore implements SecureValueStore {
  final values = <String, String>{};
  @override
  Future<void> delete(String key) async => values.remove(key);
  @override
  Future<String?> read(String key) async => values[key];
  @override
  Future<void> write(String key, String value) async => values[key] = value;
}

class FakeBrowser implements BrowserLauncher {
  bool result = true;
  Uri? opened;
  @override
  Future<bool> open(Uri uri) async {
    opened = uri;
    return result;
  }
}

class FakeCallback implements CallbackReceiver {
  final completer = Completer<NativeCallback>();
  bool closed = false;
  @override
  Future<void> close() async => closed = true;
  @override
  Future<void> cancel() async {
    closed = true;
    if (!completer.isCompleted) {
      completer.completeError(StateError('cancelled'));
    }
  }
  @override
  Future<NativeCallback> start() => completer.future;
}

class FakeGateway implements BabylonGateway {
  int messageSendCalls = 0;
  int messageStatusCalls = 0;
  int acknowledgeCalls = 0;
  String? lastMessageRequestId;
  String? lastMessagePayload;
  String? lastMessagePayloadFormat;
  BabylonApiException? messageFailure;
  BabylonApiException? messageStatusFailure;
  BabylonApiException? acknowledgeFailure;
  List<Map<String, dynamic>> pendingMessageRows = const [];
  Map<String, dynamic> messageState = {'state': 'pending'};
  bool healthy = true;
  bool authenticated = false;
  int exchanges = 0;
  int logoutCalls = 0;
  int resendCalls = 0;
  int acceptCalls = 0;
  bool failAccept = false;
  BabylonApiException? meFailure;
  String? lastState;
  Completer<void>? exchangeGate;
  final exchangeStarted = Completer<void>();
  Completer<void>? acceptGate;
  final acceptStarted = Completer<void>();
  final deviceRows = <Map<String, dynamic>>[
    {
      'id': 'device-1',
      'name': 'Teszt eszköz',
      'platform': 'windows',
      'current': true,
    },
  ];

  @override
  Future<void> acceptInvitation({
    required String email,
    required String invitationCode,
    required String transactionToken,
    required String state,
  }) async {
    acceptCalls += 1;
    if (!acceptStarted.isCompleted) acceptStarted.complete();
    await acceptGate?.future;
    if (failAccept) {
      throw BabylonApiException(401, 'UNAUTHORIZED', 'Hibás meghívó');
    }
  }

  @override
  Future<List<Map<String, dynamic>>> devices() async => List.of(deviceRows);
  @override
  Future<List<Map<String, dynamic>>> sessions() async => const [];
  @override
  Future<void> revokeSession(String id) async {}
  @override
  Future<int> revokeOtherSessions() async => 0;
  @override
  Future<List<Map<String, dynamic>>> passkeys() async => const [];
  @override
  Future<void> renamePasskey(String id, String name) async {}
  @override
  Future<void> revokePasskey(String id) async {}
  @override
  Future<List<Map<String, dynamic>>> securityEvents() async => const [];
  @override
  Future<List<String>> regenerateRecoveryCodes() async => const [];
  @override
  Future<void> startRecovery(String email) async {}
  @override
  Future<void> exchange({
    required String returnCode,
    required String pkceVerifier,
    required String state,
    required String deviceName,
    required String platform,
    required String clientDeviceKey,
  }) async {
    exchanges += 1;
    if (!exchangeStarted.isCompleted) exchangeStarted.complete();
    await exchangeGate?.future;
    authenticated = true;
  }

  @override
  Future<bool> health() async => healthy;
  @override
  Future<void> logout() async {
    logoutCalls += 1;
    authenticated = false;
  }
  @override
  Future<Map<String, dynamic>> sendMessage({required String requestId, required String recipientId,
    required String payloadFormat, required String payload}) async {
    messageSendCalls += 1;
    lastMessageRequestId = requestId;
    lastMessagePayload = payload;
    lastMessagePayloadFormat = payloadFormat;
    final failure = messageFailure;
    if (failure != null) throw failure;
    return {'requestId': requestId, ...messageState};
  }
  @override
  Future<Map<String, dynamic>> messageStatus(String requestId) async {
    messageStatusCalls += 1;
    final failure = messageStatusFailure;
    if (failure != null) throw failure;
    return {'requestId': requestId, ...messageState};
  }
  @override
  Future<List<Map<String, dynamic>>> pendingMessages({int limit = 50}) async => pendingMessageRows;
  @override
  Future<Map<String, dynamic>> acknowledgeMessage(String requestId, String senderId) async {
    acknowledgeCalls += 1;
    final failure = acknowledgeFailure;
    if (failure != null) throw failure;
    return {'requestId': requestId, 'state': 'delivered', 'deliveredAt': DateTime.now().toUtc().toIso8601String()};
  }
  @override
  Future<Map<String, dynamic>> me() async {
    final failure = meFailure;
    if (failure != null) throw failure;
    if (!authenticated) {
      throw BabylonApiException(401, 'UNAUTHORIZED', 'Nincs munkamenet');
    }
    return {
      'id': 'user-1',
      'email': 'user@example.test',
      'deviceId': 'device-1',
    };
  }

  @override
  Future<void> renameDevice(String id, String name) async =>
      deviceRows.firstWhere((row) => row['id'] == id)['name'] = name;
  @override
  Future<void> resendVerification({
    required String email,
    required String transactionToken,
    required String state,
  }) async => resendCalls += 1;
  @override
  Future<void> resumeOnboarding({
    required String email,
    required String transactionToken,
    required String state,
  }) async {}
  @override
  Future<void> revokeDevice(String id) async =>
      deviceRows.removeWhere((row) => row['id'] == id);
  @override
  Future<Map<String, dynamic>> startNativeAuth({
    required String operation,
    required String pkceChallenge,
    required String state,
  }) async {
    lastState = state;
    return {
      'transactionToken': ''.padRight(43, 't'),
      'browserUrl':
          'http://localhost:3000/auth/$operation#transaction=${''.padRight(43, 't')}&state=$state',
    };
  }
}
