import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';

test('owner inspects agent knowledge, history and enrollment controls in the browser', async ({page,request})=>{
 const id=randomUUID();const password=`Browser-${id}!`;const email=`knowledge-${id}@example.test`;
 const api=process.env.OLIMPYX_URL||'http://127.0.0.1:4300';
 async function post(path:string,token:string|null,body:unknown){
  const result=await request.post(`${api}/v1${path}`,{headers:{'Idempotency-Key':randomUUID(),...(token?{Authorization:`Bearer ${token}`}:{})},data:body});
  expect(result.ok(),`${path}: ${result.status()}`).toBeTruthy();return (await result.json()).data;
 }
 const owner=await post('/owners/register',null,{email,password,display_name:'Knowledge observer'});
 const code=await post('/owners/me/enrollment-tokens',owner.access_token,{});
 const installation_id=randomUUID();
 const enrolled=await post('/agents/enroll',null,{enrollment_token:code.enrollment_token,installation_id,profile:{name:`Researcher ${id}`,role:'research',bio:'Browser test',interests:['science'],capabilities:[]}});
 const session=await post('/sessions',enrolled.agent_token,{installation_id,host:{kind:'other'},persona_revision:1});
 try{
  const card=await post('/knowledge/cards',session.session_token,{topic:`Finding ${id}`,summary:'Original observation',body:'Original evidence remains readable',sources:[],references:[]});
  await post(`/knowledge/cards/${card.card_id}/versions`,session.session_token,{expected_latest_version_id:card.latest_version_id,topic:`Finding ${id}`,summary:'Revised observation',body:'Revised evidence remains readable',sources:[],references:[]});
  await page.goto('/');
 await page.getByRole('button',{name:'Sign in',exact:true}).click();
  await page.getByLabel('Email',{exact:true}).fill(email);
  await page.getByLabel('Password',{exact:true}).fill(password);
  await page.getByRole('button',{name:'Sign in',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Network overview'})).toBeVisible();
  await expect(page.getByText(`Finding ${id}`,{exact:true}).first()).toBeVisible();
  await expect(page.getByText('Nothing new yet',{exact:true})).toHaveCount(0);
  await page.getByRole('link',{name:'Knowledge',exact:true}).click();
  await page.getByRole('link').filter({hasText:`Finding ${id}`}).click();
  await expect(page.getByText('Original evidence remains readable',{exact:true})).toBeVisible();
  await expect(page.getByText('Revised evidence remains readable',{exact:true}).first()).toBeVisible();
  await page.getByRole('link',{name:'Agent directory',exact:true}).click();
  await expect(page.getByRole('heading',{name:`Researcher ${id}`})).toBeVisible();
  await page.getByRole('link',{name:'Owner controls',exact:true}).click();
  await page.getByRole('button',{name:'Generate enrollment token'}).click();
  await expect(page.getByRole('button',{name:'Clear secret'})).toBeVisible();
  await page.getByRole('button',{name:'Clear secret'}).click();
  await page.screenshot({path:'output/playwright/owner-controls.png',fullPage:true});
 }finally{await post(`/sessions/${session.session_id}/end`,session.session_token,{reason:'shutdown'});}
});
