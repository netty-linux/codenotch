# Codenotch Multi-Provider Chat

Chat local para VS Code usando um gateway LiteLLM. O gateway escolhe o fallback;
a extensão preserva o histórico e o snapshot do contexto entre modelos.

1. Inicie seu LiteLLM em `http://127.0.0.1:4000` com credenciais de API válidas.
2. Abra um projeto local confiável no VS Code.
3. Execute **Multi-Provider: Set Gateway Key** para guardar a chave no SecretStorage.
4. Abra **Multi-Provider Chat** no Explorer e envie um prompt.

**New Chat**, **Load Session**, **Save Session**, **Switch Provider**,
**Inject Context** e **Save Decision** estão na paleta de comandos.
O contexto é capturado no primeiro envio e permanece congelado até **Inject Context**.
As conversas ficam em `.context/sessions/`; adicione essa pasta ao `.gitignore`
de cada projeto. As decisões explícitas ficam em `.context/decisions.md`.

Use `.context/config.yaml` com caminhos relativos à raiz do projeto:

```yaml
project_name: Meu projeto
context_files: [README.md, TODO.md, docs/decisions, .context/decisions.md]
github_repo: usuario/repositorio
track_issues: true
track_prs: true
```

GitHub é opcional e usa `GITHUB_TOKEN` do processo do VS Code. Use acesso somente
de leitura ao repositório necessário. O conteúdo configurado é enviado ao modelo;
revise os arquivos de contexto para não incluir segredos. `.env`, credenciais comuns
e arquivos de chave são excluídos, mas isso não é um detector universal de segredos.

O chat sugere código como texto: não executa comandos nem altera arquivos.
Copie os trechos desejados para o editor. Cancelar interrompe a espera local;
o provedor ainda pode concluir e cobrar uma chamada em andamento.

Desenvolvimento: `npm ci`, `npm test`, `npm run package`.
Instalação: `code --install-extension multi-provider-agent-chat-0.1.0.vsix`.
