import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:package_info_plus/package_info_plus.dart';

import 'app_localizations.dart';
import 'auth_controller.dart';

class BabylonApp extends StatefulWidget {
  const BabylonApp({required this.controller, this.versionLoader, super.key});

  final AuthController controller;
  final Future<String> Function()? versionLoader;

  @override
  State<BabylonApp> createState() => _BabylonAppState();
}

class _BabylonAppState extends State<BabylonApp> with WidgetsBindingObserver {
  var _authVisible = false;
  var _privacyShieldVisible = false;
  var _version = '';

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    widget.controller.addListener(_changed);
    widget.controller.initialize();
    _loadVersion();
  }

  Future<void> _loadVersion() async {
    final version =
        await (widget.versionLoader?.call() ??
            PackageInfo.fromPlatform().then((info) => info.version));
    if (mounted) setState(() => _version = version);
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    widget.controller.removeListener(_changed);
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    final shield = state != AppLifecycleState.resumed;
    if (shield != _privacyShieldVisible && mounted) {
      setState(() => _privacyShieldVisible = shield);
    }
  }

  void _changed() => setState(() {});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      onGenerateTitle: (_) => 'Babylon',
      supportedLocales: AppLocalizations.supportedLocales,
      localizationsDelegates: const [
        AppLocalizations.delegate,
        GlobalMaterialLocalizations.delegate,
        GlobalWidgetsLocalizations.delegate,
        GlobalCupertinoLocalizations.delegate,
      ],
      theme: ThemeData(
        colorScheme: ColorScheme.fromSeed(
          seedColor: const Color(0xffd77b39),
          brightness: Brightness.dark,
        ),
        useMaterial3: true,
      ),
      home: Stack(
        children: [
          Builder(
            builder: (context) => _LandingPage(
              controller: widget.controller,
              authVisible: _authVisible,
              version: _version,
              onShowAuth: () => setState(() => _authVisible = true),
              onHideAuth: () => setState(() => _authVisible = false),
            ),
          ),
          if (_privacyShieldVisible)
            const Positioned.fill(
              child: ColoredBox(
                key: Key('privacy-shield'),
                color: Color(0xff120f0d),
                child: Center(
                  child: Text(
                    'BABYLON',
                    textDirection: TextDirection.ltr,
                    style: TextStyle(
                      color: Colors.white70,
                      fontSize: 24,
                      fontWeight: FontWeight.w800,
                      letterSpacing: 4,
                    ),
                  ),
                ),
              ),
            ),
        ],
      ),
    );
  }
}

class _LandingPage extends StatelessWidget {
  const _LandingPage({
    required this.controller,
    required this.authVisible,
    required this.version,
    required this.onShowAuth,
    required this.onHideAuth,
  });

  final AuthController controller;
  final bool authVisible;
  final String version;
  final VoidCallback onShowAuth;
  final VoidCallback onHideAuth;

  @override
  Widget build(BuildContext context) {
    final strings = AppLocalizations.of(context);
    final isNarrow = MediaQuery.sizeOf(context).width < 420;
    return Scaffold(
      body: Stack(
        fit: StackFit.expand,
        children: [
          Image.asset(
            'assets/babel-tower.png',
            fit: BoxFit.cover,
            alignment: _backgroundAlignment(MediaQuery.sizeOf(context).width),
          ),
          const DecoratedBox(
            decoration: BoxDecoration(
              gradient: LinearGradient(
                begin: Alignment.topCenter,
                end: Alignment.center,
                colors: [Color(0x66000000), Color(0x00000000)],
              ),
            ),
          ),
          SafeArea(
            child: Padding(
              padding: EdgeInsets.fromLTRB(
                isNarrow ? 12 : 20,
                16,
                isNarrow ? 12 : 20,
                14,
              ),
              child: Stack(
                children: [
                  Align(
                    alignment: Alignment.topLeft,
                    child: Text(
                      'BABYLON',
                      key: const Key('brand'),
                      style: TextStyle(
                        color: Colors.white.withValues(alpha: 0.92),
                        fontSize: _brandSize(MediaQuery.sizeOf(context).width),
                        fontWeight: FontWeight.w900,
                        letterSpacing: isNarrow ? 2 : 5,
                        height: 1,
                        shadows: const [
                          Shadow(color: Colors.black54, blurRadius: 8),
                        ],
                      ),
                    ),
                  ),
                  Align(
                    alignment: Alignment.topRight,
                    child: FilledButton(
                      key: const Key('show-auth'),
                      onPressed: onShowAuth,
                      style: FilledButton.styleFrom(
                        backgroundColor: const Color(0xffc96d32),
                        foregroundColor: Colors.white,
                        minimumSize: const Size(0, 48),
                        padding: EdgeInsets.symmetric(
                          horizontal: isNarrow ? 16 : 24,
                        ),
                        shape: const StadiumBorder(),
                        textStyle: const TextStyle(
                          fontWeight: FontWeight.w700,
                          letterSpacing: 1.2,
                        ),
                      ),
                      child: Text(strings.signIn.toUpperCase()),
                    ),
                  ),
                  if (version.isNotEmpty)
                    Align(
                      alignment: Alignment.bottomRight,
                      child: Text(
                        'an StZoo Project v.$version',
                        key: const Key('app-version'),
                        style: const TextStyle(
                          color: Colors.white,
                          fontSize: 13,
                          shadows: [Shadow(color: Colors.black, blurRadius: 5)],
                        ),
                      ),
                    ),
                ],
              ),
            ),
          ),
          if (authVisible)
            _AuthOverlay(controller: controller, onClose: onHideAuth),
        ],
      ),
    );
  }

  Alignment _backgroundAlignment(double width) {
    if (width < 600) return const Alignment(-0.24, 0);
    if (width < 900) return const Alignment(-0.08, 0);
    return const Alignment(0.28, 0);
  }

  double _brandSize(double width) {
    if (width < 420) return 16;
    if (width < 900) return 48;
    return 68;
  }
}

class _AuthOverlay extends StatelessWidget {
  const _AuthOverlay({required this.controller, required this.onClose});

  final AuthController controller;
  final VoidCallback onClose;

  @override
  Widget build(BuildContext context) {
    final strings = AppLocalizations.of(context);
    return ColoredBox(
      color: Colors.black54,
      child: SafeArea(
        child: Center(
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 620, maxHeight: 720),
            child: Card(
              margin: const EdgeInsets.all(20),
              color: const Color(0xff211b17).withValues(alpha: 0.96),
              child: Padding(
                padding: const EdgeInsets.fromLTRB(24, 12, 24, 24),
                child: Column(
                  children: [
                    Align(
                      alignment: Alignment.centerRight,
                      child: IconButton(
                        key: const Key('close-auth'),
                        tooltip: strings.close,
                        onPressed: () async {
                          await controller.cancelAuthenticationFlow();
                          onClose();
                        },
                        icon: const Icon(Icons.close),
                      ),
                    ),
                    if (controller.error != null)
                      Semantics(
                        liveRegion: true,
                        child: Text(
                          controller.error!,
                          style: const TextStyle(color: Colors.redAccent),
                        ),
                      ),
                    Expanded(child: _AuthContent(controller: controller)),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _AuthContent extends StatelessWidget {
  const _AuthContent({required this.controller});
  final AuthController controller;

  @override
  Widget build(BuildContext context) {
    final strings = AppLocalizations.of(context);
    return switch (controller.stage) {
      AuthStage.checkingBackend => const Center(
        child: CircularProgressIndicator(),
      ),
      AuthStage.unavailable => Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          Text(strings.unavailable),
          const SizedBox(height: 16),
          FilledButton(
            onPressed: controller.initialize,
            child: Text(strings.retry),
          ),
        ],
      ),
      AuthStage.signedOut => _SignedOut(controller: controller),
      AuthStage.waitingForEmail => _WaitingForEmail(controller: controller),
      AuthStage.authenticating => Center(child: Text(strings.secureSignIn)),
      AuthStage.signedIn => _SignedIn(controller: controller),
    };
  }
}

class _SignedOut extends StatefulWidget {
  const _SignedOut({required this.controller});
  final AuthController controller;

  @override
  State<_SignedOut> createState() => _SignedOutState();
}

class _SignedOutState extends State<_SignedOut> {
  final email = TextEditingController();
  final invitation = TextEditingController();

  @override
  void dispose() {
    email.dispose();
    invitation.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final strings = AppLocalizations.of(context);
    return ListView(
      children: [
        Text(
          strings.invitationRegistration,
          style: const TextStyle(fontSize: 24),
        ),
        TextField(
          controller: email,
          keyboardType: TextInputType.emailAddress,
          autofillHints: const [AutofillHints.email],
          decoration: InputDecoration(labelText: strings.email),
        ),
        TextField(
          controller: invitation,
          decoration: InputDecoration(labelText: strings.invitationCode),
        ),
        const SizedBox(height: 16),
        FilledButton(
          onPressed: () =>
              widget.controller.acceptInvitation(email.text, invitation.text),
          child: Text(strings.acceptInvitation),
        ),
        TextButton(
          onPressed: () => widget.controller.resume(email.text),
          child: Text(strings.resumeRegistration),
        ),
        const Divider(height: 40),
        OutlinedButton(
          onPressed: widget.controller.signIn,
          child: Text(strings.signInWithPasskey),
        ),
      ],
    );
  }
}

class _WaitingForEmail extends StatelessWidget {
  const _WaitingForEmail({required this.controller});
  final AuthController controller;

  @override
  Widget build(BuildContext context) {
    final strings = AppLocalizations.of(context);
    return Column(
      mainAxisAlignment: MainAxisAlignment.center,
      children: [
        const Icon(Icons.mark_email_unread_outlined, size: 64),
        const SizedBox(height: 16),
        Text(strings.checkEmail, style: const TextStyle(fontSize: 24)),
        Text(strings.checkEmailBody),
        const SizedBox(height: 16),
        OutlinedButton(
          onPressed: controller.resendEmail,
          child: Text(strings.resendEmail),
        ),
      ],
    );
  }
}

class _SignedIn extends StatelessWidget {
  const _SignedIn({required this.controller});
  final AuthController controller;

  @override
  Widget build(BuildContext context) {
    final strings = AppLocalizations.of(context);
    return ListView(
      children: [
        Text(
          strings.signedInAs(controller.profile?['email'] ?? ''),
          style: const TextStyle(fontSize: 20),
        ),
        const SizedBox(height: 20),
        Text(strings.registeredDevices, style: const TextStyle(fontSize: 18)),
        for (final device in controller.deviceList)
          ListTile(
            title: Text(device['name'] as String? ?? strings.device),
            subtitle: Text(device['platform'] as String? ?? ''),
            trailing: Wrap(
              children: [
                IconButton(
                  tooltip: strings.rename,
                  onPressed: () => _rename(context, device),
                  icon: const Icon(Icons.edit_outlined),
                ),
                IconButton(
                  tooltip: strings.revoke,
                  onPressed: () =>
                      controller.revokeDevice(device['id'] as String),
                  icon: const Icon(Icons.delete_outline),
                ),
              ],
            ),
          ),
        const SizedBox(height: 16),
        OutlinedButton(
          onPressed: controller.logout,
          child: Text(strings.logout),
        ),
      ],
    );
  }

  Future<void> _rename(
    BuildContext context,
    Map<String, dynamic> device,
  ) async {
    final strings = AppLocalizations.of(context);
    final field = TextEditingController(text: device['name'] as String?);
    final name = await showDialog<String>(
      context: context,
      builder: (context) => AlertDialog(
        title: Text(strings.renameDevice),
        content: TextField(
          controller: field,
          autofocus: true,
          decoration: InputDecoration(labelText: strings.deviceName),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context),
            child: Text(strings.cancel),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(context, field.text),
            child: Text(strings.save),
          ),
        ],
      ),
    );
    field.dispose();
    if (name != null && context.mounted) {
      await controller.renameDevice(device['id'] as String, name);
    }
  }
}
