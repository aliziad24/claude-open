# Publication, naming, and redistribution

This page is practical project guidance, not legal advice.

Anthropic documents a supported third-party inference configuration for Claude Desktop, including Windows Cowork virtualization. Claude Open follows that gateway concept and requires users to obtain the official client from its official source. The repository and bootstrap release do not redistribute Anthropic application binaries.

Public distribution is nevertheless not risk-free. Claude Open uses the Claude name to describe compatibility and applies version-checked patches to copied loose renderer files for its additional desktop integration. Anthropic's current terms restrict reverse engineering and its trademark rules restrict using Anthropic names or marks in connection with another product or in a way that implies affiliation without permission.

Risk-reduction steps:

- Keep the independent-project disclaimer prominent and never imply Anthropic endorsement.
- Do not use Anthropic logos, visual trade dress, or bundled proprietary binaries.
- Obtain written trademark/technical permission before broad promotion when possible.
- Consider a non-Claude primary product name while retaining a factual compatibility statement.
- Prefer documented third-party inference mechanisms and minimize renderer patching.
- Publish only clean exports that pass the repository and history scanners.
- Ask qualified counsel to review the intended release jurisdiction and distribution model.

Current primary references:

- [Anthropic: Set up Claude Desktop for third-party inference](https://claude.com/docs/third-party/claude-desktop/installation)
- [Anthropic Consumer Terms](https://www.anthropic.com/legal/consumer-terms)
- [Anthropic Commercial Terms](https://www.anthropic.com/legal/commercial-terms)

## Private sharing on GitHub

A personal private GitHub repository can be shared with collaborators, but each account must be invited. GitHub does not provide an anonymous private-repository link.

To manage a group, place the repository in a GitHub organization, create a team, add friends to that team, and grant the team repository access. This avoids repeating repository permissions one person at a time, although each person still needs a GitHub account and organization membership. Outside collaborators cannot be added to organization teams.

Changing an already-public repository to private cannot revoke copies that people previously cloned or downloaded.
