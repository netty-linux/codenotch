# Validação — 5 de outubro de 2026

- Extensão: TypeScript compilado; 5 testes passaram; `npm audit` sem vulnerabilidades.
- VSIX 0.1.0 gerado e instalado no VS Code local.
- Rust: 174 testes passaram; 4 testes de integração com contas/tela reais ignorados pelo upstream.
- UI original: 24 testes JavaScript passaram; scripts de todas as páginas analisados sem erro de sintaxe.
- LiteLLM 1.104.0 instalado em `.venv`; fallback testado com resposta HTTP 429 local.
- Proxy real testado com a configuração entregue e modelos substituídos por fixtures locais:
  `/v1/models`, chat com fallback e contadores Prometheus disponíveis.
- Acesso não autenticado a `/metrics` foi rejeitado no teste.
- Snapshot, histórico completo, exclusão de credenciais comuns e bloqueio de caminhos/symlinks externos testados.

Não foram feitas chamadas às APIs reais de NVIDIA, Anthropic, OpenAI ou Gemini.
O fluxo visual dentro do VS Code e a interação do notch no desktop não foram
validados manualmente. O empacotamento não comprova esses testes visuais.
Cotas comerciais, conta ativa e texto do último erro não são inferidos de
contadores agregados. Veja as limitações e configuração em `multi-provider.md`.
