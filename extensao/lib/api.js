'use strict';
async function requisicao(rota,opcoes={}){const base=await globalThis.postadorConfig.obterApiBaseUrl();const s=await globalThis.postadorStorage.lerSessao();const headers={'Content-Type':'application/json',...(opcoes.headers||{})};if(s?.token)headers.Authorization=`Bearer ${s.token}`;const r=await fetch(`${base}${rota}`,{...opcoes,headers});const d=await r.json().catch(()=>({}));if(!r.ok)throw new Error(d.erro||`API HTTP ${r.status}`);return d;}
async function entrar(email,senha){const d=await requisicao('/api/extensao/login',{method:'POST',body:JSON.stringify({email,senha})});await globalThis.postadorStorage.salvarSessao({token:d.token,expiraEm:d.expiraEm,email});await globalThis.postadorStorage.salvarLicenca(d.licenca);return d;}
async function cadastrar(nome,email,senha){const d=await requisicao('/api/extensao/cadastro',{method:'POST',body:JSON.stringify({nome,email,senha})});await globalThis.postadorStorage.salvarSessao({token:d.token,expiraEm:d.expiraEm,email});await globalThis.postadorStorage.salvarLicenca(d.licenca);return d;}
async function licenca(){const d=await requisicao('/api/extensao/licenca');await globalThis.postadorStorage.salvarLicenca(d.licenca);return d;}
async function planos(){return requisicao('/api/extensao/planos');}
async function checkout(plano){return requisicao('/api/extensao/checkout',{method:'POST',body:JSON.stringify({plano})});}
async function sair(){try{await requisicao('/api/extensao/sair',{method:'POST',body:'{}'});}finally{await globalThis.postadorStorage.limparSessao();}}
globalThis.postadorApi={entrar,cadastrar,licenca,planos,checkout,sair};
