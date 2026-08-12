import 'dart:async';
import 'dart:convert';

import 'package:http/http.dart' as http;

import 'token_store.dart';

class BabylonApiException implements Exception {
  BabylonApiException(this.statusCode, this.code, this.message);

  final int statusCode;
  final String code;
  final String message;

  @override
  String toString() => message;
}

abstract interface class BabylonGateway {
  Future<bool> health();
  Future<Map<String, dynamic>> startNativeAuth({
    required String operation,
    required String pkceChallenge,
    required String state,
  });
  Future<void> acceptInvitation({
    required String email,
    required String invitationCode,
    required String transactionToken,
    required String state,
  });
  Future<void> resendVerification({
    required String email,
    required String transactionToken,
    required String state,
  });
  Future<void> resumeOnboarding({
    required String email,
    required String transactionToken,
    required String state,
  });
  Future<void> exchange({
    required String returnCode,
    required String pkceVerifier,
    required String state,
    required String deviceName,
    required String platform,
    required String clientDeviceKey,
  });
  Future<Map<String, dynamic>> me();
  Future<List<Map<String, dynamic>>> devices();
  Future<List<Map<String, dynamic>>> sessions();
  Future<void> revokeSession(String id);
  Future<int> revokeOtherSessions();
  Future<List<Map<String, dynamic>>> passkeys();
  Future<void> renamePasskey(String id, String name);
  Future<void> revokePasskey(String id);
  Future<List<Map<String, dynamic>>> securityEvents();
  Future<List<String>> regenerateRecoveryCodes();
  Future<void> startRecovery(String email);
  Future<void> renameDevice(String id, String name);
  Future<void> revokeDevice(String id);
  Future<void> logout();
}

class BabylonApiClient implements BabylonGateway {
  BabylonApiClient({
    required this.baseUri,
    required this.tokenStore,
    http.Client? httpClient,
  }) : _http = httpClient ?? http.Client();

  static const _refreshKey = 'babylon.refresh_token';
  final Uri baseUri;
  final SecureValueStore tokenStore;
  final http.Client _http;
  String? _accessToken;
  Future<bool>? _refreshInFlight;

  Uri _uri(String path) => baseUri.resolve(path);

  Map<String, dynamic> _decode(http.Response response) {
    Map<String, dynamic> payload;
    try {
      payload = jsonDecode(response.body) as Map<String, dynamic>;
    } on FormatException {
      throw BabylonApiException(
        response.statusCode,
        'INVALID_RESPONSE',
        'A szerver hibás választ adott.',
      );
    }
    if (response.statusCode < 200 || response.statusCode >= 300) {
      final error = payload['error'] as Map<String, dynamic>? ?? const {};
      throw BabylonApiException(
        response.statusCode,
        error['code'] as String? ?? 'REQUEST_FAILED',
        error['message'] as String? ?? 'A kérés sikertelen.',
      );
    }
    return payload['data'] as Map<String, dynamic>? ?? <String, dynamic>{};
  }

  Future<Map<String, dynamic>> _post(
    String path,
    Map<String, dynamic> body,
  ) async {
    final response = await _http.post(
      _uri(path),
      headers: const {'content-type': 'application/json'},
      body: jsonEncode(body),
    );
    return _decode(response);
  }

  Future<http.Response> _authorizedRequest(
    String method,
    String path, {
    Map<String, dynamic>? body,
  }) async {
    Future<http.Response> send() {
      final request = http.Request(method, _uri(path));
      request.headers['authorization'] = 'Bearer ${_accessToken ?? ''}';
      request.headers['content-type'] = 'application/json';
      if (body != null) {
        request.body = jsonEncode(body);
      }
      return _http.send(request).then(http.Response.fromStream);
    }

    var response = await send();
    if (response.statusCode == 401 && await _refreshOnce()) {
      response = await send();
    }
    if (response.statusCode == 401) {
      await clearSession();
    }
    return response;
  }

  Future<bool> _refreshOnce() {
    final existing = _refreshInFlight;
    if (existing != null) return existing;
    final future = _performRefresh();
    _refreshInFlight = future;
    return future.whenComplete(() => _refreshInFlight = null);
  }

  Future<bool> _performRefresh() async {
    final refreshToken = await tokenStore.read(_refreshKey);
    if (refreshToken == null) return false;
    try {
      final data = await _post('/api/v1/sessions/refresh', {
        'refreshToken': refreshToken,
      });
      _accessToken = data['accessToken'] as String;
      await tokenStore.write(_refreshKey, data['refreshToken'] as String);
      return true;
    } on BabylonApiException {
      await clearSession();
      return false;
    }
  }

  Future<void> clearSession() async {
    _accessToken = null;
    await tokenStore.delete(_refreshKey);
  }

  @override
  Future<bool> health() async {
    try {
      final response = await _http.get(_uri('/health/ready'));
      return response.statusCode == 200;
    } on http.ClientException {
      return false;
    }
  }

  @override
  Future<Map<String, dynamic>> startNativeAuth({
    required String operation,
    required String pkceChallenge,
    required String state,
  }) => _post('/api/v1/native-auth/start', {
    'clientId': 'babylon-flutter',
    'returnProfile': 'desktop-local',
    'pkceChallenge': pkceChallenge,
    'state': state,
    'operation': operation,
  });

  @override
  Future<void> acceptInvitation({
    required String email,
    required String invitationCode,
    required String transactionToken,
    required String state,
  }) async {
    await _post('/api/v1/onboarding/accept-invitation', {
      'email': email,
      'invitationCode': invitationCode,
      'transactionToken': transactionToken,
      'state': state,
    });
  }

  @override
  Future<void> resendVerification({
    required String email,
    required String transactionToken,
    required String state,
  }) async {
    await _post('/api/v1/email-verification/resend', {
      'email': email,
      'transactionToken': transactionToken,
      'state': state,
    });
  }

  @override
  Future<void> resumeOnboarding({
    required String email,
    required String transactionToken,
    required String state,
  }) async {
    await _post('/api/v1/onboarding/resume', {
      'email': email,
      'transactionToken': transactionToken,
      'state': state,
    });
  }

  @override
  Future<void> exchange({
    required String returnCode,
    required String pkceVerifier,
    required String state,
    required String deviceName,
    required String platform,
    required String clientDeviceKey,
  }) async {
    final data = await _post('/api/v1/native-auth/exchange', {
      'returnCode': returnCode,
      'clientId': 'babylon-flutter',
      'pkceVerifier': pkceVerifier,
      'state': state,
      'deviceName': deviceName,
      'platform': platform,
      'clientDeviceKey': clientDeviceKey,
    });
    _accessToken = data['accessToken'] as String;
    await tokenStore.write(_refreshKey, data['refreshToken'] as String);
  }

  @override
  Future<Map<String, dynamic>> me() async {
    final response = await _authorizedRequest('GET', '/api/v1/me');
    return _decode(response);
  }

  @override
  Future<List<Map<String, dynamic>>> devices() async {
    final response = await _authorizedRequest('GET', '/api/v1/devices');
    final data = _decode(response);
    return (data['items'] as List<dynamic>? ?? const [])
        .cast<Map<String, dynamic>>();
  }

  @override
  Future<void> renameDevice(String id, String name) async {
    _decode(
      await _authorizedRequest(
        'PATCH',
        '/api/v1/devices/$id',
        body: {'name': name},
      ),
    );
  }

  @override
  Future<void> revokeDevice(String id) async {
    final response = await _authorizedRequest('DELETE', '/api/v1/devices/$id');
    if (response.statusCode != 204) _decode(response);
  }

  @override
  Future<List<Map<String, dynamic>>> sessions() async {
    final data = _decode(await _authorizedRequest('GET', '/api/v1/sessions'));
    return (data['items'] as List<dynamic>? ?? const [])
        .cast<Map<String, dynamic>>();
  }

  @override
  Future<void> revokeSession(String id) async {
    _decode(await _authorizedRequest('DELETE', '/api/v1/sessions/$id'));
  }

  @override
  Future<int> revokeOtherSessions() async {
    final data = _decode(
      await _authorizedRequest(
        'POST',
        '/api/v1/sessions/revoke-others',
        body: const {},
      ),
    );
    return data['revoked'] as int? ?? 0;
  }

  @override
  Future<List<Map<String, dynamic>>> passkeys() async {
    final data = _decode(await _authorizedRequest('GET', '/api/v1/passkeys'));
    return (data['items'] as List<dynamic>? ?? const [])
        .cast<Map<String, dynamic>>();
  }

  @override
  Future<void> renamePasskey(String id, String name) async {
    final response = await _authorizedRequest(
      'PATCH',
      '/api/v1/passkeys/$id',
      body: {'name': name},
    );
    if (response.statusCode != 204) _decode(response);
  }

  @override
  Future<void> revokePasskey(String id) async {
    final response = await _authorizedRequest('DELETE', '/api/v1/passkeys/$id');
    if (response.statusCode != 204) _decode(response);
  }

  @override
  Future<List<Map<String, dynamic>>> securityEvents() async {
    final data = _decode(
      await _authorizedRequest('GET', '/api/v1/security-events'),
    );
    return (data['items'] as List<dynamic>? ?? const [])
        .cast<Map<String, dynamic>>();
  }

  @override
  Future<List<String>> regenerateRecoveryCodes() async {
    final data = _decode(
      await _authorizedRequest(
        'POST',
        '/api/v1/recovery/codes/regenerate',
        body: const {},
      ),
    );
    return (data['codes'] as List<dynamic>? ?? const []).cast<String>();
  }

  @override
  Future<void> startRecovery(String email) async {
    await _post('/api/v1/recovery/start', {'email': email});
  }

  @override
  Future<void> logout() async {
    try {
      await _authorizedRequest(
        'POST',
        '/api/v1/sessions/logout',
        body: const {},
      );
    } finally {
      await clearSession();
    }
  }
}
