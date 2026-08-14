import 'package:flutter/widgets.dart';

class AppLocalizations {
  const AppLocalizations(this.locale);

  final Locale locale;

  static const supportedLocales = [Locale('en'), Locale('hu')];

  static AppLocalizations of(BuildContext context) =>
      Localizations.of<AppLocalizations>(context, AppLocalizations)!;

  static const delegate = _AppLocalizationsDelegate();

  bool get _hu => locale.languageCode == 'hu';

  String get signIn => _hu ? 'Bejelentkezés' : 'Sign in';
  String get close => _hu ? 'Bezárás' : 'Close';
  String get retry => _hu ? 'Újrapróbálás' : 'Try again';
  String get unavailable => _hu
      ? 'A Babylon backend nem érhető el.'
      : 'The Babylon backend is unavailable.';
  String get invitationRegistration =>
      _hu ? 'Meghívásos regisztráció' : 'Invitation registration';
  String get email => _hu ? 'E-mail-cím' : 'Email address';
  String get invitationCode => _hu ? 'Meghívókód' : 'Invitation code';
  String get acceptInvitation =>
      _hu ? 'Meghívó elfogadása' : 'Accept invitation';
  String get resumeRegistration => _hu
      ? 'Megszakadt regisztráció folytatása'
      : 'Resume interrupted registration';
  String get signInWithPasskey =>
      _hu ? 'Belépés passkeyjel' : 'Sign in with a passkey';
  String get secureSignIn =>
      _hu ? 'Biztonságos belépés folyamatban…' : 'Secure sign-in in progress…';
  String get checkEmail =>
      _hu ? 'Ellenőrizd az e-mailedet' : 'Check your email';
  String get checkEmailBody => _hu
      ? 'Nyisd meg a helyi próbalevelet ezen az eszközön. A passkey-folyamat automatikusan folytatódik.'
      : 'Open the local test email on this device. The passkey flow will continue automatically.';
  String get resendEmail => _hu ? 'Levél újraküldése' : 'Resend email';
  String signedInAs(String email) =>
      _hu ? 'Bejelentkezve: $email' : 'Signed in as: $email';
  String get registeredDevices =>
      _hu ? 'Regisztrált eszközök' : 'Registered devices';
  String get device => _hu ? 'Eszköz' : 'Device';
  String get rename => _hu ? 'Átnevezés' : 'Rename';
  String get revoke => _hu ? 'Visszavonás' : 'Revoke';
  String get logout => _hu ? 'Kijelentkezés' : 'Sign out';
  String get renameDevice => _hu ? 'Eszköz átnevezése' : 'Rename device';
  String get deviceName => _hu ? 'Eszköznév' : 'Device name';
  String get cancel => _hu ? 'Mégse' : 'Cancel';
  String get save => _hu ? 'Mentés' : 'Save';
}

class _AppLocalizationsDelegate
    extends LocalizationsDelegate<AppLocalizations> {
  const _AppLocalizationsDelegate();

  @override
  bool isSupported(Locale locale) => AppLocalizations.supportedLocales.any(
    (supported) => supported.languageCode == locale.languageCode,
  );

  @override
  Future<AppLocalizations> load(Locale locale) async =>
      AppLocalizations(locale);

  @override
  bool shouldReload(_AppLocalizationsDelegate old) => false;
}
