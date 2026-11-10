# Payday: turn your NIM into a paycheck

A [Nimiq Pay](https://nimiq.com) Mini App for the **Earn** category of the Nimiq Mini Apps Competition (Cycle III).

Most people don't think in "APY" or "delegation". They think in paychecks. Payday stakes your NIM in one tap,
shows what it pays you **every week** in NIM and your own currency, and makes the three-step Nimiq withdrawal
(deactivate → unlock → withdraw) obvious.

## What it does

- **One-tap staking.** Type an amount and see your weekly, monthly and yearly pay before you commit. A validator
  is picked for you (uptime, fee, and whether rewards compound), or choose your own from the ranked list.
- **Your weekly paycheck, live.** A big "this is what your NIM pays you each week" number, plus an
  "earned today" ticker that counts up second by second.
- **What you were actually paid.** "Paid to you" is read from the chain: your current stake minus the NIM you
  moved into staking (pools that restake add rewards straight to your stake). When the history can't be trusted
  (for example NIM staked from an older Nimiq Pay contract), Payday tracks from the day it first saw your stake
  instead of guessing, so the number is never inflated.
- **Paycheck goal.** Set "I want 100 NIM a week" and Payday tells you how much more to stake to get there.
- **Withdrawals without confusion.** A step card shows the cooldown countdown (release block computed from
  `inactiveFrom`, epoch length and validator jail status), then one tap to unlock and one to move NIM home.
- **Built for how Nimiq Pay holds money.** Nimiq Pay keeps spendable NIM in a remote HTLC account next to your basic
  address; Payday reads both (and follows `accountsChanged` when Pay rotates it), so it never wrongly shows an empty wallet.
- **Changed your mind?** "Keep earning instead" cancels a withdrawal while it cools down.
- **No double sends.** After you approve in Nimiq Pay, the screen stays in a confirming state and polls the chain
  until the change appears.
- **Switch validator** without unstaking (`sendUpdateStakerTransaction`, stake reactivates automatically).
- **Share my payday.** A share card ("My NIM pays me 20 NIM every week, while I do nothing") with a deeplink
  that opens Payday inside Nimiq Pay.
- **14 currencies** (USD, EUR, GBP, NGN, KES, ZAR, INR, BRL, CRC, GMD, CHF, CAD, AUD, JPY), defaulting to your
  Nimiq Pay currency.
- **Demo mode** outside Nimiq Pay: pretend NIM, real network rates, nothing sent. Includes a "skip the wait"
  button so the full withdrawal flow can be tried in a minute.

## Honest numbers

The yearly rate is not hard-coded. It is today's network emission (from `@nimiq/utils` `posSupplyAt`) divided by
all NIM currently in the staking contract, minus the validator's fee. Pools that pay nothing to stakers are
shown as 0% and never recommended.

## Nimiq integration

All wallet actions use the official `@nimiq/mini-app-sdk` and are approved by the user in Nimiq Pay:

| Action | SDK call |
|---|---|
| Start staking | `sendNewStakerTransaction` |
| Stake more | `sendStakeTransaction` |
| Start withdrawal | `sendSetActiveStakeTransaction` |
| Unlock | `sendRetireStakeTransaction` |
| Move to wallet | `sendRemoveStakeTransaction` |
| Switch validator | `sendUpdateStakerTransaction` |

Also used: `listAccounts`, `getHostNetwork` (mainnet/testnet), `getHostFiat`, and typed `NimiqProviderError`
handling (cancel, invalid transaction, network error, unsupported host).

Read-only data: Nimiq JSON-RPC (`getStakerByAddress`, `getAccountByAddress`, `getTransactionsByAddress`,
`getActiveValidators`, `getPolicyConstants`, `getBlockNumber`) via the public nimiqwatch RPC, validator names and
scores from the Nimiq validators API, prices from CoinGecko. There is **no backend** and Payday never holds funds.
The only thing stored is your goal and currency choice, in your browser's local storage.

## Run it

```bash
npm install
npm run dev        # serves on your LAN; open the Network URL in Nimiq Pay → Mini Apps → Custom URL
npm run build      # static files in dist/
```

Test for free on testnet: in Nimiq Pay open the menu and long-press Settings for 10 seconds to switch to testnet,
then tap **Get free NIM**. Payday follows the network Nimiq Pay is on.

## License

MIT
