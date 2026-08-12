import 'package:flutter/material.dart';

import 'auth_controller.dart';

class BabylonApp extends StatefulWidget {
  const BabylonApp({required this.controller, super.key});
  final AuthController controller;

  @override
  State<BabylonApp> createState() => _BabylonAppState();
}

class _BabylonAppState extends State<BabylonApp> {
  @override
  void initState() {
    super.initState();
    widget.controller.addListener(_changed);
    widget.controller.initialize();
  }

  @override
  void dispose() {
    widget.controller.removeListener(_changed);
    super.dispose();
  }

  void _changed() => setState(() {});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Babylon',
      theme: ThemeData(colorSchemeSeed: Colors.indigo, useMaterial3: true),
      home: Scaffold(
        appBar: AppBar(title: const Text('Babylon')),
        body: SafeArea(
          child: Center(
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 620),
              child: Padding(
                padding: const EdgeInsets.all(24),
                child: _content(),
              ),
            ),
          ),
        ),
      ),
    );
  }

  Widget _content() {
    final controller = widget.controller;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (controller.error != null)
          Semantics(
            liveRegion: true,
            child: Text(
              controller.error!,
              style: const TextStyle(color: Colors.red),
            ),
          ),
        const SizedBox(height: 12),
        Expanded(
          child: switch (controller.stage) {
            AuthStage.checkingBackend => const Center(
              child: CircularProgressIndicator(),
            ),
            AuthStage.unavailable => _Unavailable(controller: controller),
            AuthStage.signedOut => _SignedOut(controller: controller),
            AuthStage.waitingForEmail => _WaitingForEmail(
              controller: controller,
            ),
            AuthStage.authenticating => const Center(
              child: Text('Biztonságos belépés folyamatban…'),
            ),
            AuthStage.signedIn => _SignedIn(controller: controller),
          },
        ),
      ],
    );
  }
}

class _Unavailable extends StatelessWidget {
  const _Unavailable({required this.controller});
  final AuthController controller;
  @override
  Widget build(BuildContext context) => Column(
    mainAxisAlignment: MainAxisAlignment.center,
    children: [
      const Text('A Babylon backend nem érhető el.'),
      const SizedBox(height: 16),
      FilledButton(
        onPressed: controller.initialize,
        child: const Text('Újrapróbálás'),
      ),
    ],
  );
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
  Widget build(BuildContext context) => ListView(
    children: [
      const Text('Meghívásos regisztráció', style: TextStyle(fontSize: 24)),
      TextField(
        controller: email,
        keyboardType: TextInputType.emailAddress,
        autofillHints: const [AutofillHints.email],
        decoration: const InputDecoration(labelText: 'E-mail-cím'),
      ),
      TextField(
        controller: invitation,
        decoration: const InputDecoration(labelText: 'Meghívókód'),
      ),
      const SizedBox(height: 16),
      FilledButton(
        onPressed: () =>
            widget.controller.acceptInvitation(email.text, invitation.text),
        child: const Text('Meghívó elfogadása'),
      ),
      TextButton(
        onPressed: () => widget.controller.resume(email.text),
        child: const Text('Megszakadt regisztráció folytatása'),
      ),
      const Divider(height: 40),
      OutlinedButton(
        onPressed: widget.controller.signIn,
        child: const Text('Belépés passkeyjel'),
      ),
    ],
  );
}

class _WaitingForEmail extends StatelessWidget {
  const _WaitingForEmail({required this.controller});
  final AuthController controller;
  @override
  Widget build(BuildContext context) => Column(
    mainAxisAlignment: MainAxisAlignment.center,
    children: [
      const Icon(Icons.mark_email_unread_outlined, size: 64),
      const SizedBox(height: 16),
      const Text('Ellenőrizd az e-mailedet', style: TextStyle(fontSize: 24)),
      const Text(
        'Nyisd meg a helyi próbalevelet ezen az eszközön. A passkey-folyamat automatikusan folytatódik.',
      ),
      const SizedBox(height: 16),
      OutlinedButton(
        onPressed: controller.resendEmail,
        child: const Text('Levél újraküldése'),
      ),
    ],
  );
}

class _SignedIn extends StatelessWidget {
  const _SignedIn({required this.controller});
  final AuthController controller;

  @override
  Widget build(BuildContext context) => ListView(
    children: [
      Text(
        'Bejelentkezve: ${controller.profile?['email'] ?? ''}',
        style: const TextStyle(fontSize: 20),
      ),
      const SizedBox(height: 20),
      const Text('Regisztrált eszközök', style: TextStyle(fontSize: 18)),
      for (final device in controller.deviceList)
        ListTile(
          title: Text(device['name'] as String? ?? 'Eszköz'),
          subtitle: Text(device['platform'] as String? ?? ''),
          trailing: Wrap(
            children: [
              IconButton(
                tooltip: 'Átnevezés',
                onPressed: () => _rename(context, device),
                icon: const Icon(Icons.edit_outlined),
              ),
              IconButton(
                tooltip: 'Visszavonás',
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
        child: const Text('Kijelentkezés'),
      ),
    ],
  );

  Future<void> _rename(
    BuildContext context,
    Map<String, dynamic> device,
  ) async {
    final field = TextEditingController(text: device['name'] as String?);
    final name = await showDialog<String>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Eszköz átnevezése'),
        content: TextField(
          controller: field,
          autofocus: true,
          decoration: const InputDecoration(labelText: 'Eszköznév'),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context),
            child: const Text('Mégse'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(context, field.text),
            child: const Text('Mentés'),
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
