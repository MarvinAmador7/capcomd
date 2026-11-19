# CHANGELOG

- A run's goal branch is now named for you the way your repository already names its branches: with its type
  prefixes and their spelling (`feature/csv-export`, `bugfix/login-crash`), or the one prefix most of its branches
  share (`marvin/csv-export`). When the repository has no clear habit, it's the common `<type>/<slug>`:
  `feat/csv-export`, `fix/login-crash`, `docs/readme-install-steps`, with the type read from the goal's words. A
  ticket id in the goal (`ENG-142`) leads the name. This replaces `capcomd/<goal-slug>`; `--goal-branch` still names
  it yourself.
- The app's composers no longer ask you for a branch name: the name that will be used shows as a quiet line under the
  goal. Click it to change it (Return keeps your name, Escape cancels; clearing it goes back to the suggestion).
