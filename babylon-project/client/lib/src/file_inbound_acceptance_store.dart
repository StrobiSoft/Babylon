import 'dart:convert';
import 'dart:io';

import 'message_delivery.dart';

/// A small restart-safe receipt ledger. It stores identifiers only; message
/// content remains at the transport/content boundary and is never written here.
class FileInboundAcceptanceStore implements InboundAcceptanceStore {
  FileInboundAcceptanceStore._(this._file, this._states);

  static const _fileName = 'inbound-acceptances.json';
  final File _file;
  final Map<String, InboundAcceptanceState> _states;
  Future<void> _mutationTail = Future<void>.value();

  static Future<FileInboundAcceptanceStore> open(Directory directory) async {
    await directory.create(recursive: true);
    final file = File('${directory.path}${Platform.pathSeparator}$_fileName');
    if (!await file.exists()) {
      return FileInboundAcceptanceStore._(
        file,
        <String, InboundAcceptanceState>{},
      );
    }
    final decoded = jsonDecode(await file.readAsString());
    if (decoded is! Map<String, dynamic>) {
      throw const FormatException('Invalid inbound acceptance storage.');
    }
    if (decoded['version'] == 1 && decoded['keys'] is List) {
      // V1 recorded registration before consumption, so its entries cannot be
      // safely treated as complete. Replaying through the idempotent consumer is
      // the only loss-free migration.
      final states = <String, InboundAcceptanceState>{
        for (final key in (decoded['keys'] as List).cast<String>())
          key: InboundAcceptanceState.registered,
      };
      return FileInboundAcceptanceStore._(file, states);
    }
    if (decoded['version'] != 2 || decoded['receipts'] is! Map) {
      throw const FormatException('Invalid inbound acceptance storage.');
    }
    final receipts = (decoded['receipts'] as Map).cast<String, dynamic>();
    final states = receipts.map((key, value) {
      InboundAcceptanceState? state;
      for (final candidate in InboundAcceptanceState.values) {
        if (candidate.name == value) state = candidate;
      }
      if (state == null) {
        throw const FormatException('Invalid inbound acceptance state.');
      }
      return MapEntry(key, state);
    });
    return FileInboundAcceptanceStore._(file, states);
  }

  @override
  Future<InboundAcceptanceState> register(InboundDeliveryIdentity identity) {
    final result = _mutationTail.then((_) async {
      final existing = _states[identity.key];
      if (existing != null) return existing;
      await _persistMutation(identity.key, InboundAcceptanceState.registered);
      return InboundAcceptanceState.registered;
    });
    _mutationTail = result.then<void>((_) {}, onError: (_, _) {});
    return result;
  }

  @override
  Future<void> complete(InboundDeliveryIdentity identity) {
    final result = _mutationTail.then((_) async {
      if (_states[identity.key] == null) {
        throw StateError('Inbound delivery must be registered before completion.');
      }
      if (_states[identity.key] == InboundAcceptanceState.completed) return;
      await _persistMutation(identity.key, InboundAcceptanceState.completed);
    });
    _mutationTail = result.then<void>((_) {}, onError: (_, _) {});
    return result;
  }

  Future<void> _persistMutation(String key, InboundAcceptanceState state) async {
    final previous = _states[key];
    _states[key] = state;
    try {
      final ordered = Map.fromEntries(
        _states.entries.toList()
          ..sort((left, right) => left.key.compareTo(right.key)),
      );
      final temp = File('${_file.path}.tmp');
      await temp.writeAsString(
        jsonEncode({
          'version': 2,
          'receipts': ordered.map((key, value) => MapEntry(key, value.name)),
        }),
        flush: true,
      );
      await temp.rename(_file.path);
    } catch (_) {
      if (previous == null) {
        _states.remove(key);
      } else {
        _states[key] = previous;
      }
      rethrow;
    }
  }
}
