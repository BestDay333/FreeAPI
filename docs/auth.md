# Accounts and sign-in

The application stores DeepSeek Web account sessions locally.

## First account

Run:

```bash
npm run auth
```

Chrome opens for DeepSeek sign-in. The session is saved locally for the web application.

## Additional accounts

Open **Accounts → Add account** in the Dashboard. Use the DeepSeek Auth Exporter browser extension to export a session file from a signed-in DeepSeek tab, then import that file in the Dashboard.

Account files must remain private and must never be committed to git. The application stores them with restrictive file permissions.

## Concurrency

One DeepSeek Web login can serve one active chat at a time. If several conversations use the same account, they wait in a queue. Multiple accounts allow more conversations to run at once.
