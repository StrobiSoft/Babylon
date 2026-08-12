import 'package:babylon_client/src/app.dart';
import 'package:babylon_client/src/auth_controller.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'fakes.dart';

void main() {
  testWidgets('renders accessible invitation and passkey actions', (
    tester,
  ) async {
    final gateway = FakeGateway();
    final controller = AuthController(
      api: gateway,
      browser: FakeBrowser(),
      callbackFactory: FakeCallback.new,
      secureValues: MemoryStore(),
    );
    await tester.pumpWidget(BabylonApp(controller: controller));
    await tester.pumpAndSettle();
    expect(find.text('Meghívásos regisztráció'), findsOneWidget);
    expect(find.text('Meghívó elfogadása'), findsOneWidget);
    expect(find.text('Belépés passkeyjel'), findsOneWidget);
    expect(find.byType(TextField), findsNWidgets(2));
  });

  testWidgets(
    'renders authenticated profile, devices, rename, revoke and logout',
    (tester) async {
      final gateway = FakeGateway()..authenticated = true;
      final controller = AuthController(
        api: gateway,
        browser: FakeBrowser(),
        callbackFactory: FakeCallback.new,
        secureValues: MemoryStore(),
      );
      await tester.pumpWidget(BabylonApp(controller: controller));
      await tester.pumpAndSettle();
      expect(find.textContaining('user@example.test'), findsOneWidget);
      expect(find.text('Teszt eszköz'), findsOneWidget);
      expect(find.byTooltip('Átnevezés'), findsOneWidget);
      expect(find.byTooltip('Visszavonás'), findsOneWidget);
      expect(find.text('Kijelentkezés'), findsOneWidget);
    },
  );
}
