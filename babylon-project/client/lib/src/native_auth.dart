import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math';

import 'package:crypto/crypto.dart';
import 'package:url_launcher/url_launcher.dart';

String randomBase64Url([int bytes = 32]) {
  final random = Random.secure();
  return base64UrlEncode(
    List<int>.generate(bytes, (_) => random.nextInt(256)),
  ).replaceAll('=', '');
}

String s256(String verifier) => base64UrlEncode(
  sha256.convert(utf8.encode(verifier)).bytes,
).replaceAll('=', '');

abstract interface class BrowserLauncher {
  Future<bool> open(Uri uri);
}

class SystemBrowserLauncher implements BrowserLauncher {
  @override
  Future<bool> open(Uri uri) =>
      launchUrl(uri, mode: LaunchMode.externalApplication);
}

class NativeCallback {
  const NativeCallback({required this.code, required this.state});
  final String code;
  final String state;
}

abstract interface class CallbackReceiver {
  Future<NativeCallback> start();
  Future<void> close();
}

class LoopbackCallbackServer implements CallbackReceiver {
  HttpServer? _server;
  final _result = Completer<NativeCallback>();

  @override
  Future<NativeCallback> start() async {
    _server = await HttpServer.bind(
      InternetAddress.loopbackIPv4,
      43821,
      shared: false,
    );
    unawaited(_serve());
    return _result.future
        .timeout(
          const Duration(minutes: 10),
          onTimeout: () {
            throw TimeoutException('A böngészős belépés lejárt.');
          },
        )
        .whenComplete(close);
  }

  Future<void> _serve() async {
    final server = _server;
    if (server == null) return;
    await for (final request in server) {
      final code = request.uri.queryParameters['code'];
      final state = request.uri.queryParameters['state'];
      request.response.headers.contentType = ContentType.html;
      request.response.headers.set('referrer-policy', 'no-referrer');
      request.response.write(
        '<!doctype html><meta charset="utf-8"><title>Babylon</title><p>Visszatérhetsz a Babylon alkalmazásba.</p>',
      );
      await request.response.close();
      if (code != null && state != null && !_result.isCompleted) {
        _result.complete(NativeCallback(code: code, state: state));
        return;
      }
    }
  }

  @override
  Future<void> close() async => _server?.close(force: true);
}
