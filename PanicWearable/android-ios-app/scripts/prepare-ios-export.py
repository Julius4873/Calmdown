"""Prepare manual App Store signing on the temporary macOS release runner."""
import datetime
import os
import pathlib
import plistlib
import shutil

directory = pathlib.Path(os.environ['SIGNING_DIR'])
team = os.environ['TEAM_ID']
bundle = os.environ['BUNDLE_ID']
with (directory / 'profile.plist').open('rb') as stream:
    profile = plistlib.load(stream)

entitlements = profile.get('Entitlements', {})
if profile.get('TeamIdentifier') != [team]:
    raise SystemExit('Provisioning profile belongs to a different Apple team.')
if entitlements.get('application-identifier') != f'{team}.{bundle}':
    raise SystemExit('Provisioning profile does not match the app bundle ID.')
if profile.get('ProvisionedDevices') or profile.get('ProvisionsAllDevices') or entitlements.get('get-task-allow'):
    raise SystemExit('Use an App Store distribution profile.')
if profile['ExpirationDate'].replace(tzinfo=datetime.timezone.utc) <= datetime.datetime.now(datetime.timezone.utc):
    raise SystemExit('Provisioning profile has expired.')

profiles = pathlib.Path.home() / 'Library/MobileDevice/Provisioning Profiles'
profiles.mkdir(parents=True, exist_ok=True)
shutil.copyfile(directory / 'profile.mobileprovision', profiles / f"{profile['UUID']}.mobileprovision")
options = {
    'method': 'app-store-connect',
    'destination': 'export',
    'signingStyle': 'manual',
    'teamID': team,
    'signingCertificate': 'Apple Distribution',
    'provisioningProfiles': {bundle: profile['UUID']},
    'manageAppVersionAndBuildNumber': False,
    'uploadSymbols': True,
}
with (directory / 'ExportOptions.plist').open('wb') as stream:
    plistlib.dump(options, stream)
