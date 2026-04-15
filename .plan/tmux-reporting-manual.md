# tmux reporting manual for follow-up AI

This manual explains how to report back to the manager after finishing implementation work in this repository.

## Manager target

- **manager pane ID:** `%19`
- this is the pane that should receive your completion report

## Core rule

After you finish the requested implementation:

1. complete validation
2. create the commit when the task is phase-complete
3. send a one-line tmux report to pane `%19`

Do not stop at “implemented.”  
Report only after the work is actually closed for that slice.

## 1. Discover your own pane ID

Run:

```bash
MY_PANE_ID=$(tmux display-message -p -t "$TMUX_PANE" '#{pane_id}')
echo "$MY_PANE_ID"
```

You will use that pane ID in the report prefix, for example `%42`.

## 2. Completion report command

Send text first, then Enter separately.

```bash
MY_PANE_ID=$(tmux display-message -p -t "$TMUX_PANE" '#{pane_id}')
tmux send-keys -t %19 "[${MY_PANE_ID}] 完了: <summary> / <validation> / <commit-sha-or-no-commit>"
sleep 0.5
tmux send-keys -t %19 Enter
```

## 3. Report format

The report must:

- start with `[${MY_PANE_ID}]`
- stay on one line
- say whether the work succeeded or failed
- mention the main changed area
- mention validation
- mention commit SHA if a commit was created

## 4. Good examples

### Successful implementation

```bash
MY_PANE_ID=$(tmux display-message -p -t "$TMUX_PANE" '#{pane_id}')
tmux send-keys -t %19 "[${MY_PANE_ID}] 完了: /autotest 実装とCLI配線を更新、pnpm run check/build/smoke 通過、commit abc1234"
sleep 0.5
tmux send-keys -t %19 Enter
```

### Partial or blocked result

```bash
MY_PANE_ID=$(tmux display-message -p -t "$TMUX_PANE" '#{pane_id}')
tmux send-keys -t %19 "[${MY_PANE_ID}] 失敗: MCP連携は途中、check は通過したが smoke で sandbox 起動失敗、commit なし"
sleep 0.5
tmux send-keys -t %19 Enter
```

## 5. Command for manager reply

If the manager wants to respond back to your pane, the manager can use:

```bash
CHILD_PANE_ID=%42
tmux send-keys -t "${CHILD_PANE_ID}" "[%19] 受領: 続けて次の作業へ進んでください"
sleep 0.5
tmux send-keys -t "${CHILD_PANE_ID}" Enter
```

## 6. When to send the report

Send the report:

- when the full assigned task is complete
- when a phase-complete slice is validated and committed
- when you are blocked and need the manager to decide the next move

Do not send the report:

- before validation
- before commit on a phase that is meant to be committed
- while the CLI is still running checks

## 7. Minimal checklist before reporting

1. implementation finished
2. validation finished
3. commit finished if required
4. one-line summary prepared
5. tmux report sent to `%19`
