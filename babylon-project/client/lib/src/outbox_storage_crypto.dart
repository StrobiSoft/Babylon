import 'dart:convert';

import 'package:cryptography/cryptography.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

abstract interface class OutboxStorageKeyStore {
  Future<List<int>?> readKey();
  Future<void> writeKey(List<int> keyBytes);
}

class FlutterSecureOutboxStorageKeyStore implements OutboxStorageKeyStore {
  FlutterSecureOutboxStorageKeyStore({FlutterSecureStorage? storage})
      : _storage = storage ?? const FlutterSecureStorage();

  static const String _storageKey = 'babylon.outbox.storage-key.v1';

  final FlutterSecureStorage _storage;

  @override
  Future<List<int>?> readKey() async {
    final encoded = await _storage.read(key: _storageKey);
    if (encoded == null) return null;
    try {
      final bytes = base64Decode(encoded);
      if (bytes.length != OutboxStorageCrypto.keyLength) {
        throw const FormatException('Invalid outbox storage key length.');
      }
      return bytes;
    } on FormatException {
      throw const FormatException('Invalid outbox storage key encoding.');
    }
  }

  @override
  Future<void> writeKey(List<int> keyBytes) async {
    if (keyBytes.length != OutboxStorageCrypto.keyLength) {
      throw ArgumentError.value(
        keyBytes.length,
        'keyBytes',
        'Outbox storage key must be 256 bits.',
      );
    }
    await _storage.write(key: _storageKey, value: base64Encode(keyBytes));
  }
}

class OutboxStorageCrypto {
  OutboxStorageCrypto._(this._secretKey);

  static const int keyLength = 32;
  static const String algorithmName = 'AES-256-GCM';
  static const List<int> _aad = <int>[
    98,
    97,
    98,
    121,
    108,
    111,
    110,
    45,
    111,
    117,
    116,
    98,
    111,
    120,
    45,
    118,
    50,
  ];

  static final Cipher _cipher = AesGcm.with256bits();

  final SecretKey _secretKey;

  static Future<OutboxStorageCrypto> open(
    OutboxStorageKeyStore keyStore, {
    required bool allowKeyCreation,
  }) async {
    var keyBytes = await keyStore.readKey();
    if (keyBytes == null) {
      if (!allowKeyCreation) {
        throw StateError(
          'Outbox storage exists but its encryption key is unavailable.',
        );
      }
      final generated = await _cipher.newSecretKey();
      keyBytes = await generated.extractBytes();
      await keyStore.writeKey(keyBytes);
    }
    if (keyBytes.length != keyLength) {
      throw const FormatException('Invalid outbox storage key length.');
    }
    return OutboxStorageCrypto._(await _cipher.newSecretKeyFromBytes(keyBytes));
  }

  Future<String> encryptString(String clearText) async {
    final secretBox = await _cipher.encrypt(
      utf8.encode(clearText),
      secretKey: _secretKey,
      aad: _aad,
    );
    return base64Encode(secretBox.concatenation());
  }

  Future<String> decryptString(String encodedCiphertext) async {
    final List<int> bytes;
    try {
      bytes = base64Decode(encodedCiphertext);
    } on FormatException {
      throw const FormatException('Invalid encrypted outbox payload encoding.');
    }

    final SecretBox box;
    try {
      box = SecretBox.fromConcatenation(
        bytes,
        nonceLength: _cipher.nonceLength,
        macLength: _cipher.macAlgorithm.macLength,
      );
    } on ArgumentError {
      throw const FormatException('Invalid encrypted outbox payload structure.');
    }

    try {
      final clearBytes = await _cipher.decrypt(
        box,
        secretKey: _secretKey,
        aad: _aad,
      );
      return utf8.decode(clearBytes);
    } on SecretBoxAuthenticationError {
      throw const FormatException('Outbox storage authentication failed.');
    } on FormatException {
      throw const FormatException('Outbox storage plaintext is not valid UTF-8.');
    }
  }
}
