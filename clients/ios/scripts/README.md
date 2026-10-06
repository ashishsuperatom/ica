# ios scripts

- `testflight.sh` — archive the app and upload it to App Store Connect for TestFlight. Needs an Apple Account with
  App Store Connect access signed in to Xcode, or an API key (see the script's header). Raise
  `CURRENT_PROJECT_VERSION` in `project.yml` before each upload.
