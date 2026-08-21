import 'dart:async';
import 'dart:convert';

import 'package:babylon_client/src/api_client.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

import 'fakes.dart';

http.Response response(int status, Object body) => http.Response(
  jsonEncode(body),
  status,
  headers: {'content-type': 'application/json'},
);

void main() {
  test('health check reports backend availability', () async {
    final api = BabylonApiClient(
      baseUri: Uri.parse('http://localhost:3000'),
      tokenStore: MemoryStore(),
      httpClient: MockClient(
        (request) async => response(200, {
          'data': {'status': 'ready'},
        }),
      ),
    );
    expect(await api.health(), isTrue);
  });

  test(
    'exchange keeps access token in memory and refresh token in secure storage',
    () async {
      final store = MemoryStore();
      final api = BabylonApiClient(
        baseUri: Uri.parse('http://localhost:3000'),
        tokenStore: store,
        httpClient: MockClient(
          (request) async => response(200, {
            'data': {
              'accessToken': 'access-secret',
              'refreshToken': 'refresh-secret',
              'expiresIn': 60,
            },
          }),
        ),
      );
      await api.exchange(
        returnCode: 'code',
        pkceVerifier: ''.padRight(64, 'v'),
        state: ''.padRight(43, 's'),
        deviceName: 'Teszt',
        platform: 'windows',
        clientDeviceKey: ''.padRight(43, 'd'),
      );
      expect(store.values.values, contains('refresh-secret'));
      expect(store.values.values, isNot(contains('access-secret')));
    },
  );

  test(
    'concurrent 401 responses share exactly one refresh operation',
    () async {
      final store = MemoryStore()
        ..values['babylon.refresh_token'] = 'old-refresh';
      var refreshCalls = 0;
      var protectedCalls = 0;
      final refreshGate = Completer<void>();
      final api = BabylonApiClient(
        baseUri: Uri.parse('http://localhost:3000'),
        tokenStore: store,
        httpClient: MockClient((request) async {
          if (request.url.path.endsWith('/sessions/refresh')) {
            refreshCalls += 1;
            await refreshGate.future;
            return response(200, {
              'data': {
                'accessToken': 'new-access',
                'refreshToken': 'new-refresh',
              },
            });
          }
          protectedCalls += 1;
          if (request.headers['authorization'] != 'Bearer new-access') {
            return response(401, {
              'error': {'code': 'UNAUTHORIZED', 'message': 'Lejárt'},
            });
          }
          return response(200, {
            'data': {'id': 'user', 'email': 'user@example.test'},
          });
        }),
      );
      final first = api.me();
      final second = api.me();
      await Future<void>.delayed(Duration.zero);
      refreshGate.complete();
      await Future.wait([first, second]);
      expect(refreshCalls, 1);
      expect(protectedCalls, 4);
      expect(store.values['babylon.refresh_token'], 'new-refresh');
    },
  );

  test('401 refresh retries one delivery request with the same request ID', () async {
    final store = MemoryStore()
      ..values['babylon.refresh_token'] = 'old-refresh';
    var deliveryCalls = 0;
    final requestIds = <String>[];
    final api = BabylonApiClient(
      baseUri: Uri.parse('http://localhost:3000'),
      tokenStore: store,
      httpClient: MockClient((request) async {
        if (request.url.path.endsWith('/sessions/refresh')) {
          return response(200, {
            'data': {
              'accessToken': 'new-access',
              'refreshToken': 'new-refresh',
            },
          });
        }
        deliveryCalls += 1;
        requestIds.add(
          (jsonDecode(request.body) as Map<String, dynamic>)['requestId'] as String,
        );
        if (request.headers['authorization'] != 'Bearer new-access') {
          return response(401, {
            'error': {'code': 'UNAUTHORIZED', 'message': 'Lejárt'},
          });
        }
        return response(202, {
          'data': {
            'requestId': requestIds.last,
            'state': 'pending',
            'expiresAt': '2026-08-22T00:00:00Z',
          },
        });
      }),
    );
    const requestId = '00000000-0000-4000-8000-000000000021';

    final state = await api.sendMessage(
      requestId: requestId,
      recipientId: '00000000-0000-4000-8000-000000000002',
      payloadFormat: 'transport-v1',
      payload: 'b3BhcXVl',
    );

    expect(state['state'], 'pending');
    expect(deliveryCalls, 2);
    expect(requestIds, everyElement(requestId));
  });

  test(
    'failed refresh clears secure storage and logs the client out',
    () async {
      final store = MemoryStore()
        ..values['babylon.refresh_token'] = 'bad-refresh';
      final api = BabylonApiClient(
        baseUri: Uri.parse('http://localhost:3000'),
        tokenStore: store,
        httpClient: MockClient(
          (request) async => response(401, {
            'error': {'code': 'UNAUTHORIZED', 'message': 'Lejárt'},
          }),
        ),
      );
      await expectLater(api.me(), throwsA(isA<BabylonApiException>()));
      expect(store.values, isEmpty);
    },
  );

  test(
    'transient refresh failure preserves the refresh token and reports the network state',
    () async {
      final store = MemoryStore()
        ..values['babylon.refresh_token'] = 'keep-refresh';
      final api = BabylonApiClient(
        baseUri: Uri.parse('http://localhost:3000'),
        tokenStore: store,
        httpClient: MockClient((request) async {
          if (request.url.path.endsWith('/sessions/refresh')) {
            throw http.ClientException('offline');
          }
          return response(401, {
            'error': {'code': 'UNAUTHORIZED', 'message': 'Lejárt'},
          });
        }),
      );

      await expectLater(
        api.me(),
        throwsA(
          isA<BabylonApiException>()
              .having((error) => error.code, 'code', 'NETWORK_UNAVAILABLE')
              .having((error) => error.message, 'message', isNot(contains('offline'))),
        ),
      );
      expect(store.values['babylon.refresh_token'], 'keep-refresh');
    },
  );

  test('times out a stalled request without retrying it', () async {
    var calls = 0;
    final api = BabylonApiClient(
      baseUri: Uri.parse('http://localhost:3000'),
      tokenStore: MemoryStore(),
      requestTimeout: Duration.zero,
      httpClient: MockClient((_) {
        calls += 1;
        return Completer<http.Response>().future;
      }),
    );

    await expectLater(
      api.startRecovery('user@example.test'),
      throwsA(
        isA<BabylonApiException>().having(
          (error) => error.code,
          'code',
          'NETWORK_TIMEOUT',
        ),
      ),
    );
    expect(calls, 1);
  });
}
