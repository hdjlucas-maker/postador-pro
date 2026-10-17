# Tarefas do Postador Pro

Lista única dos ajustes combinados. Marcar o que concluir e remover o que não for mais necessário.
Atualizada em 17/10/2026.

## Feito
- [x] Termos e landing: avaliação de "30 dias" corrigida para "7 dias" (o valor real).
- [x] Landing: o texto fixo mostrava "10 grupos por dia" na avaliação; corrigido para 5 (o limite real).
- [x] Administrador permanente: `hdjlucas@gmail.com` e `aservicos17@gmail.com` nunca expiram (painel e extensão, com os limites do Pro).
- [x] Confirmada em produção pelo usuário (zip v1.0.50): campanha publicando nos grupos sem a falha de ativação da publicação.
- [x] Senha do admin redefinida e login conferido em produção (valor atual no `info.md`).
- [x] Imagem na extensão: as duas formas combinadas com reserva — primeiro "drop", depois o input de arquivo, depois defineProperty, conferindo a prévia entre as tentativas (já está no zip v1.0.49).
- [x] Publicação em vários grupos: corrigida a falha aleatória "Não consegui ativar a publicação nesta página" que derrubava grupos da campanha (a injeção do script acontecia durante o redirecionamento do Facebook). Agora espera a página final do grupo ficar estável, tenta a injeção de novo e avisa em caso de login/verificação; regressão travada por teste novo (zip v1.0.50).
- [x] "Usar novamente" revisado e aprovado pelo usuário em campanha real (17/10/2026); comportamento atual permanece, sem mudanças.
- [x] Painel admin: login no navegador corrigido. O `comum.js` criava funções globais (`function chamar`...) e o `admin.js`/`instalar.js` morriam com "Identifier 'chamar' has already been declared" — o clique em Entrar recarregava a página e limpava os campos, sem erro visível (a landing também ficava sem os planos). O `comum.js` agora é encapsulado, o `instalar.js` tolera elemento ausente, o e-mail volta ao topo do painel e o `#dias-avaliacao` voltou à landing; coberto pelo teste novo `tests/paginas-publicas.test.mjs`.
- [x] Login do painel admin confirmado pelo usuário em produção (17/10/2026). No mesmo dia: contas admin agora aparecem como "Permanente" na coluna Expira (sem botão de renovar 30 dias) e contam como Pro/ativas nos cartões; usuário expirado mostra a data em que o acesso venceu em vez de um traço. Nada disso muda o servidor, que já tratava admin como permanente.
- [x] Planos na landing: o botão "Escolher" do plano mensal/anual não levava a nada útil — só rolava a página para cima até "Como instalar" (parecia clique morto). Agora abre um aviso explicando que a contratação é dentro da extensão (botão "Assinar / Renovar", checkout da InfinitePay), com "Baixar extensão" que engata o aceite dos termos + download do zip. Verificado no navegador em produção, incluindo o download real do arquivo.
- [x] Restrição de grupo: quando a janela "Criar post" abre sem campo de texto (2 dos 5 grupos da campanha de 17/10), a mensagem de falha agora explica que normalmente é restrição do grupo — publicação sob aprovação, somente administradores ou membro impedido — e mostra um trecho do que a janela exibe, orientando a conferir pelo próprio Facebook. Regressão coberta no teste do content script (zip v1.0.51).
- [x] Área de assinatura e renovação na extensão (zip v1.0.52). O usuário não achava onde renovar: o botão "Assinar / Renovar" só aparecia em avaliação/expirado (conta Pro escondia), o checkout era sempre mensal e o painel não tinha nada. Agora: janela própria "Assinar / Renovar" (aberta pelo popup e pelo topo do painel) com estado da licença, planos mensal/anual com preços vindos do servidor, botão "Já paguei — verificar liberação" (reconciliação) e link direto para o checkout da InfinitePay; o botão fica sempre visível para quem está logado; a landing mostra um aviso ao voltar do checkout (/?pagamento=retorno). Verificado no navegador de teste com a extensão carregada e token real: checkout gerou link de verdade da InfinitePay e a reconciliação respondeu. Corrigido de passagem o `/api/extensao/planos`, que devolvia `p.dias` (inexistente) em vez de `p.days` — a janela mostrava "undefined dias de publicação"; teste do worker agora trava isso.

## Pendente
- [ ] Baixar o zip v1.0.52, extrair por cima e recarregar a extensão para ver a janela "Assinar / Renovar" (botão no popup e no topo do painel).
- [ ] Conferir manualmente os grupos 205302899617039 e 1992963207656905 (falharam por possível restrição de publicação): tentar publicar pelo próprio Facebook. Se confirmado, remover das próximas campanhas.
- [ ] Testar a janela "Avaliar ferramenta" da extensão (nota 4-5 publica direto; 1-3 espera aprovação no painel).
- [ ] Substituir as avaliações de exemplo por avaliações reais (ou apagar pelo painel).
- [ ] Testar o pagamento real na InfinitePay ponta a ponta (checkout -> webhook -> liberação). É o último teste combinado.
- [ ] Decidir o destino do botão "Gerar 3 variações" (a rota `/api/extensao/gerar-textos` não existe no worker; botão desabilitado com aviso).
- [ ] Recuperação de senha por e-mail: precisa de domínio próprio + binding `EMAIL` no worker (hoje o caminho é o painel/WhatsApp).
- [ ] Publicar na Chrome Web Store (taxa única de US$ 5) — decisão do usuário.
- [ ] Acompanhar o grupo "Point de Divulgação 2": uma falha "Publicação não confirmada" (pode ser regra do próprio grupo).
