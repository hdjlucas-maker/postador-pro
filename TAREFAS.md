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

## Pendente
- [ ] Testar a janela "Avaliar ferramenta" da extensão (nota 4-5 publica direto; 1-3 espera aprovação no painel).
- [ ] Substituir as avaliações de exemplo por avaliações reais (ou apagar pelo painel).
- [ ] Testar o pagamento real na InfinitePay ponta a ponta (checkout -> webhook -> liberação). É o último teste combinado.
- [ ] Decidir o destino do botão "Gerar 3 variações" (a rota `/api/extensao/gerar-textos` não existe no worker; botão desabilitado com aviso).
- [ ] Recuperação de senha por e-mail: precisa de domínio próprio + binding `EMAIL` no worker (hoje o caminho é o painel/WhatsApp).
- [ ] Publicar na Chrome Web Store (taxa única de US$ 5) — decisão do usuário.
- [ ] Acompanhar o grupo "Point de Divulgação 2": uma falha "Publicação não confirmada" (pode ser regra do próprio grupo).
