import 'dart:convert';
import 'dart:io';

import 'message_delivery.dart';

/// A small restart-safe receipt ledger. It stores identifiers only; message
/// content remains at the transport/content boundary and is never written here.
class FileInboundAcceptanceStore implements InboundAcceptanceStore {
  FileInboundAcceptanceStore._(this._file, this._accepted);

  static const _fileName = 'inbound-acceptances.json';
  final File _file;
  final Set<String> _accepted;
  Future<void> _mutationTail = Future<void>.value();

  static Future<FileInboundAcceptanceStore> open(Directory directory) async {
    await directory.create(recursive: true);
    final file = File('${directory.path}${Platform.pathSeparator}$_fileName');
    if (!await file.exists()) {
      return FileInboundAcceptanceStore._(file, <String>{});
    }
    final decoded = jsonDecode(await file.readAsString());
    if (decoded is! Map<String, dynamic> ||
        decoded['version'] != 1 ||
        decoded['keys'] is! List) {
      throw const FormatException('Invalid inbound acceptance storage.');
    }
    final keys = (decoded['keys'] as List).cast<String>().toSet();
    return FileInboundAcceptanceStore._(file, keys);
  }

  @override
  Future<bool> accept(String senderId, String requestId) {
    final result = _mutationTail.then((_) async {
      final key = '$senderId\u0000$requestId';
      if (_accepted.contains(key)) return false;
      _accepted.add(key);
      try {
        final temp = File('${_file.path}.tmp');
        await temp.writeAsString(
          jsonEncode({'version': 1, 'keys': _accepted.toList()..sort()}),
          flush: true,
        );
        await temp.rename(_file.path);
        return true;
      } catch (_) {
        _accepted.remove(key);
        rethrow;
      }
    });
    _mutationTail = result.then<void>((_) {}, onError: (_, _) {});
    return result;
  }
}
