/**
 * hooks — shell snippets that run `cvx activate` on directory change, so the
 * linked Convex account is selected automatically as you move between projects.
 * One per supported shell; `cvx hook` prints the right one, `--install` wires it
 * into the shell's startup file.
 */

export type Shell = "zsh" | "bash" | "powershell" | "fish" | "nu";

// zsh: chpwd fires only on a real directory change — cheapest hook.
export const HOOK_ZSH = `
# --- convex-switch ---------------------------------------------------------
# Auto-activate the linked Convex account when you cd into a project.
_convex_switch_hook() { command cvx activate -q 2>/dev/null }
autoload -Uz add-zsh-hook 2>/dev/null && add-zsh-hook chpwd _convex_switch_hook
_convex_switch_hook   # run once for the current directory
# --- end convex-switch -----------------------------------------------------
`.trimStart();

// bash: no chpwd, so hook PROMPT_COMMAND and guard on $PWD changing.
export const HOOK_BASH = `
# --- convex-switch ---------------------------------------------------------
# Auto-activate the linked Convex account when you cd into a project.
__convex_switch_hook() {
  if [ "$PWD" != "$__CVX_LAST_PWD" ]; then
    __CVX_LAST_PWD="$PWD"
    command cvx activate -q 2>/dev/null
  fi
}
case "$PROMPT_COMMAND" in
  *__convex_switch_hook*) ;;
  *) PROMPT_COMMAND="__convex_switch_hook\${PROMPT_COMMAND:+; \$PROMPT_COMMAND}" ;;
esac
# --- end convex-switch -----------------------------------------------------
`.trimStart();

// PowerShell (native Windows): no chpwd either, so wrap the prompt function
// once and fire when $PWD changes.
export const HOOK_PWSH = `
# --- convex-switch ---------------------------------------------------------
# Auto-activate the linked Convex account when you change directory.
if (-not $global:__cvx_hooked) {
  $global:__cvx_hooked = $true
  $global:__cvx_last = ''
  $global:__cvx_orig_prompt = $function:prompt
  function global:prompt {
    if ($PWD.Path -ne $global:__cvx_last) {
      $global:__cvx_last = $PWD.Path
      cvx activate -q 2>$null | Out-Null
    }
    if ($global:__cvx_orig_prompt) { & $global:__cvx_orig_prompt } else { "PS $($PWD.Path)> " }
  }
}
# --- end convex-switch -----------------------------------------------------
`.trimStart();

// fish: has a native "fire when a variable changes" event for $PWD.
export const HOOK_FISH = `
# --- convex-switch ---------------------------------------------------------
# Auto-activate the linked Convex account when you cd into a project.
function __convex_switch_hook --on-variable PWD
  command cvx activate -q 2>/dev/null
end
__convex_switch_hook
# --- end convex-switch -----------------------------------------------------
`.trimStart();

// Nushell: register a PWD env-change hook. Best-effort — hook syntax varies by
// Nushell version; tested against recent releases.
export const HOOK_NU = `
# --- convex-switch ---------------------------------------------------------
# Auto-activate the linked Convex account when you change directory.
$env.config.hooks.env_change.PWD = (
  $env.config.hooks.env_change.PWD? | default [] | append {|before, after| ^cvx activate -q }
)
# --- end convex-switch -----------------------------------------------------
`.trimStart();

export const SHELLS: Shell[] = ["zsh", "bash", "powershell", "fish", "nu"];

export function hookFor(shell: Shell): string {
  switch (shell) {
    case "bash": return HOOK_BASH;
    case "powershell": return HOOK_PWSH;
    case "fish": return HOOK_FISH;
    case "nu": return HOOK_NU;
    default: return HOOK_ZSH;
  }
}

/** Best-effort shell detection when the user doesn't pass --shell. */
export function detectShell(): Shell {
  if (process.platform === "win32") return "powershell";
  const sh = process.env.SHELL ?? "";
  if (sh.includes("fish")) return "fish";
  if (sh.includes("nu")) return "nu";
  if (sh.includes("bash")) return "bash";
  return "zsh"; // default on unix
}
