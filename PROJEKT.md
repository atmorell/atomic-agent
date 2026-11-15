# PROJEKT — atomic-agent (egen fork)

> Loftet: 300 linjer / 30 KB. Rammes det, flyttes emner ud i `docs/<emne>.md`.
> Filen findes kun på grenen `fusion-cache`. `main` følger upstream uændret.

## Hvad det er

Fork af `AtomicBot-ai/atomic-agent` (remote `upstream`); `origin` er
`atmorell/atomic-agent`. Grenen `fusion-cache` bærer rettelserne, der får
Claudes prompt-cache til at ramme i fusion (Claude styrer gennem Claude-CLI'en,
lokal Qwen koder). Gamer-PC'en kører bygget fra denne gren, ikke upstreams
installationsprogram. Målinger og lab-fakta står i `C:\Code\sys-architecture`
(`STATUS.md`, `LAB.md`), ikke her.

## Hvad grenen ændrer

Se selv: `git log --oneline main..fusion-cache`

- `src/llm/provider/subscription-cli/cli-session-chain.ts`: den faste del af
  prompten (alt før `### capabilities`) går i CLI'ens systemprompt. Første kald
  navngiver en session; senere kald fortsætter den og sender kun det nye, uden
  Claudes eget svar. Ændret fast del, omskrevet samtale eller en gentaget prompt
  åbner en ny session.
- `src/llm/grammar/repair-tool-call-json.ts`: én glemt lukkeparentes i et
  værktøjskald sættes ind, og tekst efter den lukkede rod ignoreres. Reglerne
  for skrive-værktøjer og afkortede svar gælder stadig.
- `src/llm/grammar/tool-call-grammar.ts`: åbner svaret med værktøjskaldet, er
  det kaldet. Et kald i en digtet fortsættelse bagefter vinder ikke længere.
- `src/agent/step/step-reasoning.ts`: et svar, der åbner med kaldet, læses ikke
  som en fortsat tænkeblok. Før blev kaldet slugt af et løst `</think>` til sidst.
- `src/prompt/default-tool-args-schemas.ts`: skemaet for `fusion.delegate`
  kender `etaSeconds`, som prompten selv beder om.
- `localModels.managed.ubatchSize` (ny indstilling, standard `0`): sætter
  `--ubatch-size` på den styrede llama-server. `0` ændrer intet. Ligger i
  `src/config/local-models/` og `src/local-llm/server/daemon-lifecycle.ts`.
- Kodevagten (`llm.runMode.fusion.questionProvider`, `questionMaxPerTurn`,
  standard 3): orkestratorens spørgsmål går til den model først
  (`src/agent/policies/question-escalation.ts`). `ANSWER:` → turen fortsætter
  uden dig; `CANNOT:` → spørgsmålet kommer til dig. Hemmeligheder, smag og
  godkendelse af noget uden retur er altid `CANNOT`. Sporet: `question_escalated`.
  `turn_started.route` bærer model og effort for alle trin. Vælges i sys-win11
  (8890, «Trin og effort»).
- Forsøgt og forkastet: at fortsætte sessionen efter et afvist svar. Claude
  stolede på sit eget digtede resultat. Står som et commit og dets tilbagerulning.

## Opdatering fra upstream

Node 25.7 ligger i `~/.atomic-agent-byg/node-v25.7.0-win-x64`. Alt køres i Git Bash.

1. Hent upstream og flyt `main`:

       git fetch upstream
       git checkout main && git merge --ff-only upstream/main && git push origin main

2. Flyt rettelserne oven på:

       git checkout fusion-cache && git rebase main

   Konflikter ligger næsten altid i filerne ovenfor. Har upstream selv
   løst det samme, droppes det commit.

3. Byg:

       export PATH="/c/Users/atmorell/.atomic-agent-byg/node-v25.7.0-win-x64:$PATH"
       npm ci
       npm run build && npm run bundle:sea && npm run bundle:build-binary && npm run bundle:package

   Resultatet er `bundle/win32-x64/`. Kopiér mappen til
   `~/.atomic-agent-byg/fusion-cache-<kort sha>/win32-x64/`.
   `bundle:package` hang én gang (15-11) efter `bundle ready` og `sha256:`; zip og exe var
   færdige. Står den stille efter de to linjer, så stop dens node-processer og gå videre.

4. Repoets egne prøver for de rørte områder:

       npx vitest run src/llm/grammar src/llm/provider/subscription-cli src/agent/step src/prompt

   På Windows fejler seks prøver ens på uændret `main` (linjeskift i
   `build-grammar` og `tool-call-branches`, `spawn-einval` og
   `host-environment`). Alt andet skal være grønt. `npm run docs:check`
   fejler af samme grund (`core.autocrlf=true` ændrer arkivfilernes sha256);
   kun linjer uden `archive` tæller.

5. Opgave 1 på bygget, før det installeres:

       cd /c/Code/sys-architecture/vaerktoej/fusion-proeve
       PROEVE_AA="$HOME/.atomic-agent-byg/fusion-cache-<kort sha>/win32-x64/atomic-agent.exe" python forloeb.py <præfiks> kun=f1a

   Kravet er `pytest 0`. Rødt: installér ikke.

6. Geninstallér. Luk Atomic Agent først.

       "$LOCALAPPDATA/Programs/Atomic Agent/resources/agent/atomic-agent.exe" models stop
       python /c/Code/sys-architecture/vaerktoej/atomic-eget-byg/laeg-ind.py fusion-cache-<kort sha>

   Scriptet skal melde `0 afviger efter kopiering`. Det flytter også
   skrivebordsprogrammets opdateringskilde væk og slår agentens opdateringstjek fra.
   Start programmet med `python …/atomic-eget-byg/start-atomic.py`, ikke fra
   Claude-appen: kun sådan når brugervariablerne (MTP, 2 GB cache) motoren.

7. Kør opgave 1 igen uden `PROEVE_AA`, og push: `git push --force-with-lease origin fusion-cache`

## Automatisk opdatering

Tre kanaler. De to første ville lægge upstreams agent tilbage:

| Kanal | Slået fra med |
|---|---|
| Skrivebordsprogrammet (electron-updater) | `resources\app-update.yml` omdøbt til `app-update.yml.fra-<dato>` |
| Agentens tjek ved start | brugervariablen `ATOMIC_AGENT_UPDATE_CHECK_ON_STARTUP=false` |
| Motoren (`localModels.managed.autoUpdate`) | står til — den skriver kun under `~/.atomic-agent/models` |

Installerer du selv en ny udgave af skrivebordsprogrammet, er rettelsen væk
igen: kør trin 6.

## Tilbage til originalen

Den oprindelige 0.7.0 ligger i `~/.atomic-agent-byg/original-installeret-0.7.0/`
med `LAES-MIG.txt`. Kopiér `agent\` tilbage over
`%LOCALAPPDATA%\Programs\Atomic Agent\resources\agent\` og `app-update.yml`
tilbage i `resources\`. Data fra før skiftet:
`~/.atomic-agent-kopi-2026-11-14-1440` (alt undtagen modelvægtene).
