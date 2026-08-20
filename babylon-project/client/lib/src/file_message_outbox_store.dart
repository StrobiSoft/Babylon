import 'dart:convert';
import 'dart:io';

import 'message_outbox.dart';

class FileMessageOutboxStore implements MessageOutboxStore {
  FileMessageOutboxStore._(this._file, this._messages);

  static const int _schemaVersion = 1;
  static const String _fileName = 'message-outbox.json';

  final File _file;
  final Map<String, OutboxMessage> _messages;
  Future<void> _mutationTail = Future<void>.value();

  static Future<FileMessageOutboxStore> open(Directory directory) async {
    await directory.create(recursive: true);
    final file = File('${directory.path}${Platform.pathSeparator}$_fileName');
    final backup = File('${file.path}.bak');

    if (!await file.exists() && await backup.exists()) {
      await backup.rename(file.path);
    }

    final messages = await _load(file);
    final store = FileMessageOutboxStore._(file, messages);
    final recovered = store._recoverInterruptedSends();
    if (recovered) {
      await store._persist();
    }
    return store;
  }

  static Future<Map<String, OutboxMessage>> _load(File file) async {
    if (!await file.exists()) return <String, OutboxMessage>{};

    final raw = await file.readAsString();
    if (raw.trim().isEmpty) {
      throw const FormatException('Outbox storage is empty or truncated.');
    }

    final Object? decoded;
    try {
      decoded = jsonDecode(raw);
    } on FormatException {
      throw const FormatException('Outbox storage contains invalid JSON.');
    }
    if (decoded is! Map<String, dynamic>) {
      throw const FormatException('Outbox storage root must be an object.');
    }
    if (decoded['schemaVersion'] != _schemaVersion) {
      throw const FormatException('Unsupported outbox storage schema version.');
    }
    final items = decoded['messages'];
    if (items is! List<dynamic>) {
      throw const FormatException('Outbox storage messages must be a list.');
    }

    final result = <String, OutboxMessage>{};
    for (final item in items) {
      if (item is! Map<String, dynamic>) {
        throw const FormatException('Outbox storage contains an invalid message entry.');
      }
      final message = _decodeMessage(item);
      if (result.containsKey(message.requestId)) {
        throw const FormatException('Outbox storage contains duplicate request IDs.');
      }
      result[message.requestId] = message;
    }
    return result;
  }

  static OutboxMessage _decodeMessage(Map<String, dynamic> json) {
    String requiredString(String key) {
      final value = json[key];
      if (value is! String || value.trim().isEmpty) {
        throw FormatException('Invalid outbox message field: $key.');
      }
      return value;
    }

    DateTime requiredDate(String key) {
      final raw = requiredString(key);
      final value = DateTime.tryParse(raw);
      if (value == null) {
        throw FormatException('Invalid outbox message date: $key.');
      }
      return value.toUtc();
    }

    DateTime? optionalDate(String key) {
      final raw = json[key];
      if (raw == null) return null;
      if (raw is! String) {
        throw FormatException('Invalid outbox message date: $key.');
      }
      final value = DateTime.tryParse(raw);
      if (value == null) {
        throw FormatException('Invalid outbox message date: $key.');
      }
      return value.toUtc();
    }

    final statusName = requiredString('status');
    final status = OutboxMessageStatus.values.where((item) => item.name == statusName).firstOrNull;
    if (status == null) {
      throw const FormatException('Invalid outbox message status.');
    }

    final style = json['style'];
    final pendingReason = json['pendingReason'];
    if (style != null && style is! String) {
      throw const FormatException('Invalid outbox message style.');
    }
    if (pendingReason != null && pendingReason is! String) {
      throw const FormatException('Invalid outbox pending reason.');
    }

    return OutboxMessage(
      requestId: requiredString('requestId'),
      recipientId: requiredString('recipientId'),
      sourceText: requiredString('sourceText'),
      targetLanguage: requiredString('targetLanguage'),
      style: style as String?,
      createdAt: requiredDate('createdAt'),
      status: status,
      pendingReason: pendingReason as String?,
      deliveredAt: optionalDate('deliveredAt'),
    );
  }

  bool _recoverInterruptedSends() {
    var changed = false;
    for (final entry in _messages.entries.toList(growable: false)) {
      if (entry.value.status == OutboxMessageStatus.sending) {
        _messages[entry.key] = entry.value.copyWith(
          status: OutboxMessageStatus.queued,
          clearPendingReason: true,
        );
        changed = true;
      }
    }
    return changed;
  }

  @override
  Future<void> put(OutboxMessage message) => _serializeMutation(() async {
        final previous = _messages[message.requestId];
        _messages[message.requestId] = message;
        try {
          await _persist();
        } catch (_) {
          if (previous == null) {
            _messages.remove(message.requestId);
          } else {
            _messages[message.requestId] = previous;
          }
          rethrow;
        }
      });

  @override
  Future<OutboxMessage?> get(String requestId) async => _messages[requestId];

  @override
  Future<List<OutboxMessage>> pendingMessages() async {
    final messages = _messages.values
        .where((message) => message.status != OutboxMessageStatus.delivered)
        .toList(growable: false);
    messages.sort((left, right) => left.createdAt.compareTo(right.createdAt));
    return messages;
  }

  @override
  Future<void> delete(String requestId) => _serializeMutation(() async {
        final previous = _messages.remove(requestId);
        if (previous == null) return;
        try {
          await _persist();
        } catch (_) {
          _messages[requestId] = previous;
          rethrow;
        }
      });

  Future<void> _serializeMutation(Future<void> Function() action) {
    final operation = _mutationTail.then((_) => action());
    _mutationTail = operation.then<void>((_) {}, onError: (_, _) {});
    return operation;
  }

  Future<void> _persist() async {
    final temp = File('${_file.path}.tmp');
    final backup = File('${_file.path}.bak');
    final items = _messages.values.toList(growable: false)
      ..sort((left, right) => left.createdAt.compareTo(right.createdAt));
    final payload = <String, dynamic>{
      'schemaVersion': _schemaVersion,
      'messages': items.map(_encodeMessage).toList(growable: false),
    };

    await temp.writeAsString(jsonEncode(payload), flush: true);

    if (await backup.exists()) await backup.delete();
    if (await _file.exists()) await _file.rename(backup.path);
    try {
      await temp.rename(_file.path);
      if (await backup.exists()) await backup.delete();
    } catch (_) {
      if (!await _file.exists() && await backup.exists()) {
        await backup.rename(_file.path);
      }
      rethrow;
    } finally {
      if (await temp.exists()) await temp.delete();
    }
  }

  static Map<String, dynamic> _encodeMessage(OutboxMessage message) => <String, dynamic>{
        'requestId': message.requestId,
        'recipientId': message.recipientId,
        'sourceText': message.sourceText,
        'targetLanguage': message.targetLanguage,
        'style': message.style,
        'createdAt': message.createdAt.toUtc().toIso8601String(),
        'status': message.status.name,
        'pendingReason': message.pendingReason,
        'deliveredAt': message.deliveredAt?.toUtc().toIso8601String(),
      };
}
