import 'dart:async';
import 'dart:convert';
import 'dart:math';

import 'package:flutter/foundation.dart';

import 'message_delivery.dart';
import 'message_outbox.dart';

enum ComposerMode { softChat, translation }

extension ComposerModePresentation on ComposerMode {
  String get label => switch (this) {
    ComposerMode.softChat => 'Soft Chat',
    ComposerMode.translation => 'Translation',
  };
}

class ComposerDraft {
  const ComposerDraft({this.recipientId = '', this.text = '', required this.mode});
  final String recipientId;
  final String text;
  final ComposerMode mode;
}

class ReceivedChatMessage {
  const ReceivedChatMessage({required this.senderId, required this.requestId, required this.text, required this.receivedAt});
  final String senderId;
  final String requestId;
  final String text;
  final DateTime receivedAt;
}

abstract interface class ReceivedChatStore {
  Future<void> accept(InboundDeliveryIdentity identity, String text);
  Future<List<ReceivedChatMessage>> allMessages();
}

class MemoryReceivedChatStore implements ReceivedChatStore {
  final Map<String, ReceivedChatMessage> _messages = {};

  @override
  Future<void> accept(InboundDeliveryIdentity identity, String text) async {
    _messages.putIfAbsent(identity.key, () => ReceivedChatMessage(
      senderId: identity.senderId,
      requestId: identity.requestId,
      text: text,
      receivedAt: DateTime.now().toUtc(),
    ));
  }

  @override
  Future<List<ReceivedChatMessage>> allMessages() async =>
      (_messages.values.toList()..sort((a, b) => a.receivedAt.compareTo(b.receivedAt)));
}

class SoftChatController extends ChangeNotifier {
  SoftChatController({required this.outbox, required this.delivery, required this.receivedStore, DateTime Function()? now})
      : _now = now ?? (() => DateTime.now().toUtc());

  final MessageOutbox outbox;
  final MessageDeliveryCoordinator delivery;
  final ReceivedChatStore receivedStore;
  final DateTime Function() _now;
  List<OutboxMessage> sent = const [];
  List<ReceivedChatMessage> received = const [];
  Object? receiveError;
  bool refreshing = false;
  ComposerMode _activeComposerMode = ComposerMode.softChat;

  static const selectableComposerModes = <ComposerMode>[ComposerMode.softChat];
  ComposerMode get activeComposerMode => _activeComposerMode;

  void selectComposerMode(ComposerMode mode) {
    if (!selectableComposerModes.contains(mode)) throw StateError('${mode.label} is not available.');
    if (_activeComposerMode == mode) return;
    _activeComposerMode = mode;
    notifyListeners();
  }

  Future<void> refresh() async {
    if (refreshing) return;
    refreshing = true;
    notifyListeners();
    try {
      await delivery.receiveAndAcknowledge((identity, payload, format) async {
        if (format != 'transport-v1') throw FormatException('Unsupported message format: $format');
        final text = utf8.decode(base64Decode(payload));
        await receivedStore.accept(identity, text);
      });
      receiveError = null;
    } catch (error) {
      receiveError = error;
    } finally {
      sent = await outbox.allMessages();
      received = await receivedStore.allMessages();
      refreshing = false;
      notifyListeners();
    }
  }

  Future<void> send(ComposerDraft draft) async {
    final recipient = draft.recipientId.trim();
    if (recipient.isEmpty || draft.text.trim().isEmpty) {
      throw ArgumentError('Recipient and message are required.');
    }
    if (!selectableComposerModes.contains(draft.mode) || draft.mode != _activeComposerMode) {
      throw StateError('Composer mode is unavailable or is not active.');
    }
    final message = OutboxMessage(
      requestId: _requestId(), recipientId: recipient, sourceText: draft.text,
      targetLanguage: 'none', createdAt: _now(),
    );
    try {
      await delivery.send(message);
    } finally {
      sent = await outbox.allMessages();
      notifyListeners();
    }
  }

  Future<void> retry(String requestId) async {
    await delivery.retry(requestId);
    await refresh();
  }

  static String _requestId() {
    final random = Random.secure();
    final bytes = List<int>.generate(16, (_) => random.nextInt(256));
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    final hex = bytes.map((b) => b.toRadixString(16).padLeft(2, '0')).join();
    return '${hex.substring(0, 8)}-${hex.substring(8, 12)}-${hex.substring(12, 16)}-${hex.substring(16, 20)}-${hex.substring(20)}';
  }
}
