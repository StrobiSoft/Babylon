import 'dart:convert';
import 'dart:io';

import 'message_delivery.dart';

/// A small restart-safe receipt ledger. It stores identifiers only; message
/// content remains at the transport/content boundary and is never written here.
class FileInboundAcceptanceStore implements InboundAcceptanceStore {
  FileInboundAcceptanceStore._(this._file, this._receipts, this._now);

  static const _fileName = 'inbound-acceptances.json';
  static const _lateDeliveryGrace = Duration(days: 1);
  static const _legacyMigrationRetention = Duration(days: 8);
  final File _file;
  final Map<String, _InboundReceipt> _receipts;
  final DateTime Function() _now;
  Future<void> _mutationTail = Future<void>.value();

  static Future<FileInboundAcceptanceStore> open(
    Directory directory, {
    DateTime Function()? now,
  }) async {
    final clock = now ?? () => DateTime.now().toUtc();
    await directory.create(recursive: true);
    final file = File('${directory.path}${Platform.pathSeparator}$_fileName');
    if (!await file.exists()) {
      return FileInboundAcceptanceStore._(file, <String, _InboundReceipt>{}, clock);
    }
    final decoded = jsonDecode(await file.readAsString());
    if (decoded is! Map<String, dynamic>) {
      throw const FormatException('Invalid inbound acceptance storage.');
    }
    if (decoded['version'] == 1 && decoded['keys'] is List) {
      // V1 recorded registration before consumption, so its entries cannot be
      // safely treated as complete. Replaying through the idempotent consumer is
      // the only loss-free migration.
      final receipts = <String, _InboundReceipt>{
        for (final key in (decoded['keys'] as List).cast<String>())
          key: _InboundReceipt(
            InboundAcceptanceState.registered,
            clock().toUtc().add(_legacyMigrationRetention),
          ),
      };
      final store = FileInboundAcceptanceStore._(file, receipts, clock);
      await store._persist();
      return store;
    }
    if ((decoded['version'] != 2 && decoded['version'] != 3) ||
        decoded['receipts'] is! Map) {
      throw const FormatException('Invalid inbound acceptance storage.');
    }
    final receipts = (decoded['receipts'] as Map).cast<String, dynamic>();
    final parsed = receipts.map((key, value) {
      final stateValue = value is Map ? value['state'] : value;
      InboundAcceptanceState? state;
      for (final candidate in InboundAcceptanceState.values) {
        if (candidate.name == stateValue) state = candidate;
      }
      if (state == null) {
        throw const FormatException('Invalid inbound acceptance state.');
      }
      final retainUntil = value is Map && value['retainUntil'] is String
          ? DateTime.parse(value['retainUntil'] as String).toUtc()
          : clock().toUtc().add(_legacyMigrationRetention);
      return MapEntry(key, _InboundReceipt(state, retainUntil));
    });
    final originalCount = parsed.length;
    parsed.removeWhere((_, receipt) => !receipt.retainUntil.isAfter(clock().toUtc()));
    final store = FileInboundAcceptanceStore._(file, parsed, clock);
    if (decoded['version'] != 3 || parsed.length != originalCount) await store._persist();
    return store;
  }

  @override
  Future<InboundAcceptanceState> register(InboundDeliveryIdentity identity) {
    final result = _mutationTail.then((_) async {
      await _pruneExpired(exceptKey: identity.key);
      final existing = _receipts[identity.key];
      if (existing != null) return existing.state;
      await _persistMutation(
        identity.key,
        _InboundReceipt(
          InboundAcceptanceState.registered,
          identity.expiresAt.toUtc().add(_lateDeliveryGrace),
        ),
      );
      return InboundAcceptanceState.registered;
    });
    _mutationTail = result.then<void>((_) {}, onError: (_, _) {});
    return result;
  }

  @override
  Future<void> complete(InboundDeliveryIdentity identity) {
    final result = _mutationTail.then((_) async {
      final receipt = _receipts[identity.key];
      if (receipt == null) {
        throw StateError('Inbound delivery must be registered before completion.');
      }
      if (receipt.state == InboundAcceptanceState.completed) return;
      await _persistMutation(
        identity.key,
        _InboundReceipt(InboundAcceptanceState.completed, receipt.retainUntil),
      );
    });
    _mutationTail = result.then<void>((_) {}, onError: (_, _) {});
    return result;
  }

  Future<void> _pruneExpired({required String exceptKey}) async {
    final expired = _receipts.entries
        .where((entry) => entry.key != exceptKey && !entry.value.retainUntil.isAfter(_now().toUtc()))
        .map((entry) => entry.key)
        .toList();
    if (expired.isEmpty) return;
    final previous = Map<String, _InboundReceipt>.from(_receipts);
    for (final key in expired) {
      _receipts.remove(key);
    }
    try {
      await _persist();
    } catch (_) {
      _receipts
        ..clear()
        ..addAll(previous);
      rethrow;
    }
  }

  Future<void> _persistMutation(String key, _InboundReceipt receipt) async {
    final previous = _receipts[key];
    _receipts[key] = receipt;
    try {
      await _persist();
    } catch (_) {
      if (previous == null) {
        _receipts.remove(key);
      } else {
        _receipts[key] = previous;
      }
      rethrow;
    }
  }

  Future<void> _persist() async {
    final ordered = Map.fromEntries(
      _receipts.entries.toList()..sort((left, right) => left.key.compareTo(right.key)),
    );
    final temp = File('${_file.path}.tmp');
    await temp.writeAsString(
      jsonEncode({
        'version': 3,
        'receipts': ordered.map(
          (key, value) => MapEntry(key, {
            'state': value.state.name,
            'retainUntil': value.retainUntil.toUtc().toIso8601String(),
          }),
        ),
      }),
      flush: true,
    );
    await temp.rename(_file.path);
  }
}

class _InboundReceipt {
  const _InboundReceipt(this.state, this.retainUntil);

  final InboundAcceptanceState state;
  final DateTime retainUntil;
}
