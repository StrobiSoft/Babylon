import 'dart:convert';
import 'dart:io';

import 'message_delivery.dart';
import 'outbox_storage_crypto.dart';
import 'soft_chat.dart';

class FileReceivedChatStore implements ReceivedChatStore {
  FileReceivedChatStore._(this._file, this._crypto, this._messages);

  final File _file;
  final OutboxStorageCrypto _crypto;
  final Map<String, ReceivedChatMessage> _messages;
  Future<void> _tail = Future.value();

  static Future<FileReceivedChatStore> open(Directory directory, {OutboxStorageKeyStore? keyStore}) async {
    final file = File('${directory.path}${Platform.pathSeparator}received-chat.json');
    final crypto = await OutboxStorageCrypto.open(
      keyStore ?? FlutterSecureOutboxStorageKeyStore(),
      allowKeyCreation: !await file.exists(),
    );
    final messages = <String, ReceivedChatMessage>{};
    if (await file.exists()) {
      final envelope = jsonDecode(await file.readAsString()) as Map<String, dynamic>;
      if (envelope['version'] != 1 || envelope['algorithm'] != OutboxStorageCrypto.algorithmName) {
        throw const FormatException('Unsupported received chat storage.');
      }
      final decoded = jsonDecode(await crypto.decryptString(envelope['ciphertext'] as String)) as List;
      for (final value in decoded.cast<Map<String, dynamic>>()) {
        final message = ReceivedChatMessage(
          senderId: value['senderId'] as String,
          requestId: value['requestId'] as String,
          text: value['text'] as String,
          receivedAt: DateTime.parse(value['receivedAt'] as String).toUtc(),
        );
        messages['${message.senderId}\u0000${message.requestId}'] = message;
      }
    }
    return FileReceivedChatStore._(file, crypto, messages);
  }

  @override
  Future<void> accept(InboundDeliveryIdentity identity, String text) {
    final operation = _tail.then((_) async {
      if (_messages.containsKey(identity.key)) return;
      _messages[identity.key] = ReceivedChatMessage(
        senderId: identity.senderId, requestId: identity.requestId,
        text: text, receivedAt: DateTime.now().toUtc(),
      );
      try { await _persist(); } catch (_) { _messages.remove(identity.key); rethrow; }
    });
    _tail = operation.then<void>((_) {}, onError: (_, _) {});
    return operation;
  }

  @override
  Future<List<ReceivedChatMessage>> allMessages() async =>
      (_messages.values.toList()..sort((a, b) => a.receivedAt.compareTo(b.receivedAt)));

  Future<void> _persist() async {
    final items = await allMessages();
    final ciphertext = await _crypto.encryptString(jsonEncode(items.map((message) => {
      'senderId': message.senderId, 'requestId': message.requestId,
      'text': message.text, 'receivedAt': message.receivedAt.toIso8601String(),
    }).toList()));
    final temporary = File('${_file.path}.tmp');
    await temporary.writeAsString(jsonEncode({
      'version': 1, 'algorithm': OutboxStorageCrypto.algorithmName, 'ciphertext': ciphertext,
    }), flush: true);
    await temporary.rename(_file.path);
  }
}
