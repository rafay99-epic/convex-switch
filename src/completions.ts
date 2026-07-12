/**
 * completions — shell completion scripts for cvx. They complete subcommands and,
 * for account-taking subcommands, live account names by shelling out to
 * `cvx accounts --names` (which prints one bare name per line).
 */

// Subcommands that take an account name as their first argument.
const ACCOUNT_CMDS = "link rm rename run refresh use email";
const SUBCOMMANDS =
  "login add link unlink rm rename email activate use scan run open status accounts ls which prompt refresh doctor hook completions keychain vault export import upgrade undo reset disable enable welcome version help";

const ZSH = `#compdef cvx
_cvx() {
  local -a _cmds
  _cmds=(${SUBCOMMANDS})
  if (( CURRENT == 2 )); then
    _describe -t commands 'cvx command' _cmds
    return
  fi
  case "\${words[2]}" in
    ${ACCOUNT_CMDS.split(" ").join("|")})
      if (( CURRENT == 3 )); then
        local -a _accts
        _accts=(\${(f)"\$(cvx accounts --names 2>/dev/null)"})
        _describe -t accounts 'account' _accts
      fi ;;
    unlink|open|which|scan) _files -/ ;;
    import|export) _files ;;
    completions) _values 'shell' zsh bash fish powershell ;;
    hook) _values 'shell' zsh bash fish nu powershell ;;
    keychain) _values 'subcommand' status enable disable ;;
    vault) _values 'subcommand' status encrypt decrypt unlock lock ;;
  esac
}
_cvx "\$@"
`;

const BASH = `_cvx() {
  local cur cmds
  cur="\${COMP_WORDS[COMP_CWORD]}"
  cmds="${SUBCOMMANDS}"
  if [ "\$COMP_CWORD" -eq 1 ]; then
    COMPREPLY=( \$(compgen -W "\$cmds" -- "\$cur") ); return
  fi
  case "\${COMP_WORDS[1]}" in
    ${ACCOUNT_CMDS.split(" ").join("|")})
      if [ "\$COMP_CWORD" -eq 2 ]; then
        COMPREPLY=( \$(compgen -W "\$(cvx accounts --names 2>/dev/null)" -- "\$cur") )
      fi ;;
    completions) COMPREPLY=( \$(compgen -W "zsh bash fish powershell" -- "\$cur") ) ;;
    hook) COMPREPLY=( \$(compgen -W "zsh bash fish nu powershell --install --shell" -- "\$cur") ) ;;
    keychain) COMPREPLY=( \$(compgen -W "status enable disable" -- "\$cur") ) ;;
    vault) COMPREPLY=( \$(compgen -W "status encrypt decrypt unlock lock" -- "\$cur") ) ;;
    unlink|open|which|scan) COMPREPLY=( \$(compgen -d -- "\$cur") ) ;;
    import|export) COMPREPLY=( \$(compgen -f -- "\$cur") ) ;;
  esac
}
complete -F _cvx cvx
`;

const FISH = `# cvx fish completions
complete -c cvx -f
complete -c cvx -n "__fish_use_subcommand" -a "${SUBCOMMANDS}"
complete -c cvx -n "__fish_seen_subcommand_from ${ACCOUNT_CMDS}" -a "(cvx accounts --names 2>/dev/null)"
complete -c cvx -n "__fish_seen_subcommand_from completions" -a "zsh bash fish powershell"
complete -c cvx -n "__fish_seen_subcommand_from hook" -a "zsh bash fish nu powershell"
complete -c cvx -n "__fish_seen_subcommand_from keychain" -a "status enable disable"
complete -c cvx -n "__fish_seen_subcommand_from vault" -a "status encrypt decrypt unlock lock"
complete -c cvx -n "__fish_seen_subcommand_from import export" -F
`;

const PWSH = `Register-ArgumentCompleter -Native -CommandName cvx -ScriptBlock {
  param($wordToComplete, $commandAst, $cursorPosition)
  $cmds = @(${SUBCOMMANDS.split(" ").map((c) => `'${c}'`).join(",")})
  $tokens = @($commandAst.CommandElements | ForEach-Object { $_.ToString() })
  if ($tokens.Count -le 2) {
    $cmds | Where-Object { $_ -like "$wordToComplete*" } |
      ForEach-Object { [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterValue', $_) }
    return
  }
  $sub = $tokens[1]
  $vals = @()
  if ($sub -in 'link','rm','rename','run','refresh','use','email') { $vals = @(cvx accounts --names 2>$null) }
  elseif ($sub -eq 'completions') { $vals = 'zsh','bash','fish','powershell' }
  elseif ($sub -eq 'hook') { $vals = 'zsh','bash','fish','nu','powershell' }
  elseif ($sub -eq 'keychain') { $vals = 'status','enable','disable' }
  elseif ($sub -eq 'vault') { $vals = 'status','encrypt','decrypt','unlock','lock' }
  $vals | Where-Object { $_ -like "$wordToComplete*" } |
    ForEach-Object { [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterValue', $_) }
}
`;

export function completionFor(shell: string): string | null {
  switch (shell) {
    case "zsh": return ZSH;
    case "bash": return BASH;
    case "fish": return FISH;
    case "powershell": case "pwsh": return PWSH;
    default: return null;
  }
}
