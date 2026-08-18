import 'package:babylon_client/src/app.dart';
import 'package:babylon_client/src/auth_controller.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'fakes.dart';

void main() {
  testWidgets('shows only the landing actions before sign-in is opened', (
    tester,
  ) async {
    final gateway = FakeGateway();
    final controller = AuthController(
      api: gateway,
      browser: FakeBrowser(),
      callbackFactory: FakeCallback.new,
      secureValues: MemoryStore(),
    );
    await tester.pumpWidget(
      BabylonApp(controller: controller, versionLoader: () async => '1.0.0'),
    );
    await tester.pumpAndSettle();
    expect(find.text('BABYLON'), findsOneWidget);
    expect(find.byKey(const Key('show-auth')), findsOneWidget);
    expect(find.byKey(const Key('app-version')), findsOneWidget);
    expect(find.text('an StZoo Project v.1.0.0'), findsOneWidget);
    expect(find.byType(TextField), findsNothing);

    await tester.tap(find.byKey(const Key('show-auth')));
    await tester.pumpAndSettle();
    expect(find.text('Invitation registration'), findsOneWidget);
    expect(find.text('Accept invitation'), findsOneWidget);
    expect(find.text('Sign in with a passkey'), findsOneWidget);
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
      await tester.pumpWidget(
        BabylonApp(controller: controller, versionLoader: () async => '1.0.0'),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('show-auth')));
      await tester.pumpAndSettle();
      expect(find.textContaining('user@example.test'), findsOneWidget);
      expect(find.text('Teszt eszköz'), findsOneWidget);
      expect(find.byTooltip('Rename'), findsOneWidget);
      expect(find.byTooltip('Revoke'), findsOneWidget);
      expect(find.text('Sign out'), findsOneWidget);
    },
  );

  testWidgets('uses Hungarian strings when the device locale is Hungarian', (
    tester,
  ) async {
    tester.platformDispatcher.localesTestValue = const [Locale('hu')];
    addTearDown(tester.platformDispatcher.clearLocalesTestValue);
    final controller = AuthController(
      api: FakeGateway(),
      browser: FakeBrowser(),
      callbackFactory: FakeCallback.new,
      secureValues: MemoryStore(),
    );
    await tester.pumpWidget(
      BabylonApp(controller: controller, versionLoader: () async => '1.0.0'),
    );
    await tester.pumpAndSettle();
    expect(find.text('BEJELENTKEZÉS'), findsOneWidget);
    await tester.tap(find.byKey(const Key('show-auth')));
    await tester.pumpAndSettle();
    expect(find.text('Meghívásos regisztráció'), findsOneWidget);
  });

  testWidgets('covers sensitive content while the application is inactive', (
    tester,
  ) async {
    final gateway = FakeGateway()..authenticated = true;
    final controller = AuthController(
      api: gateway,
      browser: FakeBrowser(),
      callbackFactory: FakeCallback.new,
      secureValues: MemoryStore(),
    );
    await tester.pumpWidget(
      BabylonApp(controller: controller, versionLoader: () async => '1.0.0'),
    );
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('show-auth')));
    await tester.pumpAndSettle();
    expect(find.textContaining('user@example.test'), findsOneWidget);

    await tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);
    await tester.pump();
    expect(find.byKey(const Key('privacy-shield')), findsOneWidget);

    await tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
    await tester.pump();
    expect(find.byKey(const Key('privacy-shield')), findsNothing);
  });

  for (final size in const [Size(320, 568), Size(412, 915), Size(1440, 900)]) {
    testWidgets(
      'landing page has no overflow at ${size.width}x${size.height}',
      (tester) async {
        tester.view.physicalSize = size;
        tester.view.devicePixelRatio = 1;
        addTearDown(tester.view.resetPhysicalSize);
        addTearDown(tester.view.resetDevicePixelRatio);
        final controller = AuthController(
          api: FakeGateway(),
          browser: FakeBrowser(),
          callbackFactory: FakeCallback.new,
          secureValues: MemoryStore(),
        );
        await tester.pumpWidget(
          BabylonApp(
            controller: controller,
            versionLoader: () async => '1.0.0',
          ),
        );
        await tester.pumpAndSettle();
        expect(tester.takeException(), isNull);
        expect(find.byKey(const Key('show-auth')), findsOneWidget);
        expect(find.byKey(const Key('app-version')), findsOneWidget);
        final brand = tester.getRect(find.byKey(const Key('brand')));
        final button = tester.getRect(find.byKey(const Key('show-auth')));
        expect(brand.right, lessThan(button.left));
        expect((brand.top - button.top).abs(), lessThan(14));
        expect(button.right, lessThanOrEqualTo(size.width - 12));
      },
    );
  }
}
