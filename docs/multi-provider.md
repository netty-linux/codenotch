# Codenotch Extended: LiteLLM + chat

Fork: https://github.com/netty-linux/codenotch — branch `feature/multi-provider-agent`.
Upstream correto: `vinzdg/codenotch`. A integração nativa deste fork fica em
`windows/` (Rust/Tauri + HTML); o app Swift/macOS continua sem essa integração.

## Instalação do gateway

No PowerShell, na raiz:

```powershell
python -m venv .venv
.\.venv\Scripts\python -m pip install -r requirements-proxy.txt
Copy-Item .env.example .env
```

Preencha `.env` localmente. Os IDs dos modelos são os disponíveis na sua conta,
com prefixo LiteLLM: `openai/` para NVIDIA NIM/OpenAI, `anthropic/` para Claude,
`gemini/` para Google AI Studio. Remova de `model_list` e dos fallbacks os provedores
que não usar. Não há garantia de free tier, RPM ou acesso aos modelos do prompt original.
Confira os termos e o plano de cada conta antes de habilitar chamadas reais.

Gere uma chave aleatória para `LITELLM_MASTER_KEY`. Para o modo local simples,
`LITELLM_API_KEY` deve ter o mesmo valor. Não reutilize chaves de provedores como
chave do gateway. Virtual keys, orçamento persistente e spend por conta requerem
configuração adicional de banco de dados no LiteLLM; não estão provisionados aqui.

```powershell
# Carrega .env somente no processo do gateway; não altera variáveis globais.
.\.venv\Scripts\python -m dotenv -f .env run -- .\.venv\Scripts\litellm --config litellm_config.yaml --host 127.0.0.1 --port 4000
```

Alternativamente exporte as variáveis no terminal e rode `Scripts/start-litellm.ps1`.
O proxy fica restrito ao loopback. A configuração usa três retries, timeout de
30 s por tentativa e fallbacks sem ciclos. O limite total do chat é 120 s.
Não se implementa rotação de contas; o fallback usa somente APIs autorizadas.

Referências: [configuração LiteLLM](https://docs.litellm.ai/docs/proxy/configs),
[fallbacks](https://docs.litellm.ai/docs/proxy/reliability),
[métricas](https://docs.litellm.ai/docs/proxy/prometheus).

## Extensão VS Code

```powershell
cd multi-provider-agent-chat
npm ci
npm test
npm run package
code --install-extension multi-provider-agent-chat-0.1.0.vsix
```

Abra o Explorer → Multi-Provider Chat. Use **Multi-Provider: Set Gateway Key**.
A chave fica no cofre do VS Code. Configure `multi-provider-agent.litellmBaseUrl`
e `defaultModel` quando necessário. **Switch Provider** consulta `/v1/models`.
A extensão envia o histórico completo, apresenta o modelo retornado e permite cancelar.
URLs remotas exigem HTTPS; o destino é uma configuração de máquina.

As sessões em `.context/sessions/<uuid>.json` são gravadas de forma atômica e
restauradas na abertura do painel. O snapshot inclui contexto, hash, modelo,
histórico e timestamps. **Inject Context** atualiza o snapshot; sem esse comando
a retomada usa exatamente o contexto salvo. O Git inclui branch, commit, status
e cinco commits recentes. As issues/PRs são opcionais com `GITHUB_TOKEN` de leitura.
Uma falha do GitHub aparece nos avisos do contexto e não bloqueia o chat.

Use **Save Decision** para registrar decisões em `.context/decisions.md` e atualizar
o snapshot. Inclua esse arquivo no YAML. Não há extração automática de decisões
nem execução de ferramentas pelo modelo. É um chat de desenvolvimento com memória,
não um executor autônomo de tarefas. Arquivos de contexto são limitados a 40 arquivos,
8 mil caracteres por arquivo e 40 mil no total; histórico acima de 180 mil caracteres
pede uma nova sessão. Orçamentos são em caracteres, não tokens do modelo.

## Anéis nativos Windows

Compile em `windows/` com `cargo build --locked`. Antes de iniciar o executável,
defina `CODENOTCH_LITELLM_URL=http://127.0.0.1:4000` e `LITELLM_API_KEY` no ambiente
dele. O módulo é opt-in; sem a URL, os provedores originais seguem o comportamento normal.

Opcionalmente informe limites reais contratados (não os exemplos do prompt):

```powershell
$env:CODENOTCH_LITELLM_LIMITS='{"nvidia-nim":{"rpm":40,"tpm":10000}}'
```

Esses valores são exemplos de configuração, **não** a quota da NVIDIA. Configure
os mesmos limites em `litellm_params.rpm/tpm` para que o gateway os aplique.
O anel indica taxa estimada / limite configurado, com `~`. Sem limite ou amostra
anterior há um traço, nunca uma cota inventada. Cada rota tem sua célula com sigla do provedor.
O hover mostra RPM/TPM estimados por diferença de contadores, spend, fallbacks e
falhas, quando exportados. O monitor consulta novamente após 5 segundos; atrasos
de rede podem alongar o intervalo. Falhas mantêm os dados anteriores como stale.

As métricas agregadas por rota **não** revelam saldo do free tier, conta ativa,
provedor final de cada chamada ou texto do último erro. O modelo efetivo aparece
nas respostas do chat. Aumento do contador de fallback dispara aviso no notch.
Métricas ausentes são `unknown`; contadores reiniciados não produzem taxas negativas.
`/metrics` deve ter autenticação habilitada e o callback Prometheus disponível
na sua edição/configuração do LiteLLM. Falta de acesso é apresentada como indisponível.

O instalador original não foi alterado; a identidade do fork é `Codenotch Extended`.
O atualizador aponta para o fork, evitando instalação automática do upstream.
Não há release assinada do fork neste momento.

Para gerar o instalador otimizado com o helper de hooks:

```powershell
cd windows
cargo build --release --locked -p codenotch-hook --target-dir target/hook
cd codenotch
cargo tauri build --bundles nsis --config tauri.bundle.conf.json
```

O instalador fica em `windows/target/release/bundle/nsis/`. O fork ainda compartilha
o diretório de preferências e a configuração de hooks com o Codenotch original;
use apenas uma variante por vez. Nenhum instalador original é sobrescrito.

## Verificação sem chaves reais

```powershell
.\.venv\Scripts\python Scripts/test-fallback.py --proxy
cd multi-provider-agent-chat
npm test
cd ../windows
cargo test --locked
node scripts/check-ui-scripts.mjs
```

O teste Python faz uma requisição real ao fixture HTTP local, recebe 429 e verifica
que o Router do LiteLLM chama o backup. Com `--proxy`, também inicia o gateway real,
consulta modelos, envia chat e verifica métricas autenticadas. Não gera uma rajada em um provedor real.
Os testes da extensão verificam memória, caminhos, symlinks e conversas HTTP.
Chamadas reais a NVIDIA, Claude, OpenAI e Gemini dependem de credenciais e modelos
válidos; testes locais não comprovam disponibilidade, preço ou termos dessas contas.
As metas de latência dependem de rede, tamanho dos arquivos e provedor, e não são
garantidas pelos timeouts.
