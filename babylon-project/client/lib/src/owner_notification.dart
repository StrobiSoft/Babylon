import 'dart:convert';

const ownerReplyOkId = '01K4J8Q2N6C9R5T3V7W0X1YBZA';
const ownerReplyNoId = '01K4J9R3P7D0S6V2W8X1Y5ZBCA';
const ownerReplyWaitId = '01K4JAT4Q8E1R7W3X9Y2Z6ABCD';

enum OwnerDecision { approve, reject, wait }

extension OwnerDecisionWire on OwnerDecision {
  String get replyMacroId => switch (this) {
    OwnerDecision.approve => ownerReplyOkId,
    OwnerDecision.reject => ownerReplyNoId,
    OwnerDecision.wait => ownerReplyWaitId,
  };
}

class OwnerDecisionReply {
  const OwnerDecisionReply({
    required this.eventId,
    required this.decision,
    required this.timestamp,
    required this.sequence,
    required this.senderId,
    required this.returnRoute,
  });

  static const protocolVersion = '0.1';
  final String eventId;
  final OwnerDecision decision;
  final DateTime timestamp;
  final int sequence;
  final String senderId;
  final String returnRoute;

  Map<String, Object> toJson() => {
    'protocol_version': protocolVersion,
    'event_id': eventId,
    'reply_macro_id': decision.replyMacroId,
    'sequence': sequence,
    'timestamp': timestamp.toUtc().toIso8601String(),
    'sender_id': senderId,
    'return_route': returnRoute,
  };

  String serialize() => jsonEncode(toJson());
}

class EndpointMacroExpansion {
  const EndpointMacroExpansion({
    required this.id,
    required this.version,
    required this.text,
  });

  final String id;
  final String version;
  final String text;

  String get key => '$id@$version';

  factory EndpointMacroExpansion.fromJson(Map<String, dynamic> json) =>
      EndpointMacroExpansion(
        id: _requiredString(json, 'id'),
        version: _requiredString(json, 'version'),
        text: _requiredString(json, 'text'),
      );
}

sealed class OwnerNotificationFragment {
  const OwnerNotificationFragment();

  factory OwnerNotificationFragment.fromJson(Map<String, dynamic> json) {
    return switch (_requiredString(json, 'kind')) {
      'macro' => OwnerMacroFragment(
        group: _requiredString(json, 'group'),
        macroId: _requiredString(json, 'macroId'),
        macroVersion: _requiredString(json, 'macroVersion'),
      ),
      'optional_text' => OwnerOptionalTextFragment(
        text: _requiredString(json, 'text'),
      ),
      final kind =>
        throw FormatException('Unknown notification fragment: $kind'),
    };
  }

  String expand(Map<String, EndpointMacroExpansion> expansions);
}

class OwnerMacroFragment extends OwnerNotificationFragment {
  const OwnerMacroFragment({
    required this.group,
    required this.macroId,
    required this.macroVersion,
  });

  final String group;
  final String macroId;
  final String macroVersion;

  @override
  String expand(Map<String, EndpointMacroExpansion> expansions) {
    final expansion = expansions['$macroId@$macroVersion'];
    if (expansion == null) {
      throw FormatException(
        'Missing endpoint expansion for $macroId@$macroVersion',
      );
    }
    return expansion.text;
  }
}

class OwnerOptionalTextFragment extends OwnerNotificationFragment {
  const OwnerOptionalTextFragment({required this.text});
  final String text;

  @override
  String expand(Map<String, EndpointMacroExpansion> expansions) => text;
}

class OwnerNotificationDelivery {
  const OwnerNotificationDelivery({
    required this.eventId,
    required this.messageId,
    required this.fragments,
    required this.expansions,
    required this.returnRoute,
  });

  final String eventId;
  final String messageId;
  final List<OwnerNotificationFragment> fragments;
  final Map<String, EndpointMacroExpansion> expansions;
  final String returnRoute;

  String get expandedText =>
      fragments.map((fragment) => fragment.expand(expansions)).join(' ');

  factory OwnerNotificationDelivery.fromJson(Map<String, dynamic> json) {
    final notification = _requiredMap(json, 'notification');
    if (_requiredString(notification, 'protocolVersion') != '0.1') {
      throw const FormatException('Unsupported notification protocol version');
    }
    final rawFragments = _requiredList(notification, 'fragments');
    final rawExpansions = _requiredList(json, 'expansions');
    final replyContext = _requiredMap(json, 'reply_context');
    final expansions = [
      for (final value in rawExpansions)
        EndpointMacroExpansion.fromJson(_asMap(value, 'expansion')),
    ];
    final table = <String, EndpointMacroExpansion>{};
    for (final expansion in expansions) {
      if (table.containsKey(expansion.key)) {
        throw FormatException('Duplicate endpoint expansion: ${expansion.key}');
      }
      table[expansion.key] = expansion;
    }
    final delivery = OwnerNotificationDelivery(
      eventId: _requiredUuid(notification, 'eventId'),
      messageId: _requiredUuid(notification, 'messageId'),
      fragments: [
        for (final value in rawFragments)
          OwnerNotificationFragment.fromJson(_asMap(value, 'fragment')),
      ],
      expansions: table,
      returnRoute: _requiredOpaqueHandle(replyContext, 'return_route'),
    );
    delivery.expandedText;
    return delivery;
  }
}

Map<String, dynamic> _requiredMap(Map<String, dynamic> json, String key) =>
    _asMap(json[key], key);

Map<String, dynamic> _asMap(Object? value, String name) {
  if (value is! Map<String, dynamic>) {
    throw FormatException('$name must be an object');
  }
  return value;
}

List<dynamic> _requiredList(Map<String, dynamic> json, String key) {
  final value = json[key];
  if (value is! List<dynamic>) throw FormatException('$key must be an array');
  return value;
}

String _requiredString(Map<String, dynamic> json, String key) {
  final value = json[key];
  if (value is! String || value.isEmpty) {
    throw FormatException('$key must be a non-empty string');
  }
  return value;
}

final _uuidPattern = RegExp(
  r'^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
  caseSensitive: false,
);

String _requiredUuid(Map<String, dynamic> json, String key) {
  final value = _requiredString(json, key);
  if (!_uuidPattern.hasMatch(value)) throw FormatException('$key must be a UUID');
  return value;
}

final _opaqueHandlePattern = RegExp(r'^[A-Za-z0-9_-]{16,128}$');

String _requiredOpaqueHandle(Map<String, dynamic> json, String key) {
  final value = _requiredString(json, key);
  if (!_opaqueHandlePattern.hasMatch(value)) {
    throw FormatException('$key must be an opaque handle');
  }
  return value;
}
