import { test, expect } from '@playwright/test';

// City Shell: reduced motion keeps every screen open/close instant, and switching HUD screens now
// requires "Back to the city" first (the HUD is inert while a screen covers the city — CityShell.tsx).
test.use({ reducedMotion: 'reduce' });

test('human owner registers, creates room, posts and observes persisted message',async({page})=>{
 test.setTimeout(60000);
 const id=Date.now().toString();
 await page.goto('/');
 await page.getByRole('button',{name:'Sign in',exact:true}).click();
 await page.getByRole('button',{name:'Need an owner account? Register'}).click();
 await page.getByLabel('Display name').fill('Browser verifier');
 await page.getByLabel('Email',{exact:true}).fill(`browser-${id}@example.test`);
 await page.getByLabel('Password',{exact:true}).fill(`Browser-check-${id}!`);
 await page.getByRole('button',{name:'Create account',exact:true}).click();
 // Signing in lands on the city overview (no dashboard screen any more).
 await expect(page.getByRole('heading',{name:'Olimpyx city',exact:true})).toBeAttached();
 await page.getByRole('link',{name:'Rooms',exact:true}).click();
 await page.getByRole('button',{name:'New room'}).click();
 await page.getByLabel('Title',{exact:true}).fill(`Browser room ${id}`);
 await page.getByRole('button',{name:'Create room',exact:true}).click();
 await page.getByRole('textbox',{name:'Message',exact:true}).fill(`Persistent browser message ${id}`);
 await page.getByRole('button',{name:'Send message',exact:true}).click();
 await expect(page.getByText(`Persistent browser message ${id}`,{exact:true})).toBeVisible();
 await page.reload();
 // The reload lands back on the room screen (its URL); the HUD "Rooms" nav is inert while it is open,
 // so use the room screen's own "All rooms" action instead of "Back to the city" + "Rooms".
 await page.getByRole('link',{name:'All rooms',exact:true}).click();
 // The new room also names a building in the inert city underneath the open Rooms screen (CityShell.tsx
 // sets `inert` via a ref, which a role query does not treat as hidden); scope to the directory list.
 await page.locator('.room-list').getByRole('button').filter({hasText:`Browser room ${id}`}).click();
 await expect(page.getByText(`Persistent browser message ${id}`,{exact:true})).toBeVisible();
 // Populate enough history to exercise paging and the periodic refresh.
 await page.evaluate(async ({id})=>{
  const session=JSON.parse(sessionStorage.getItem('olimpyx.session')!);
  const headers={Authorization:`Bearer ${session.token}`,'Content-Type':'application/json'};
  const rooms=await (await fetch('/v1/rooms',{headers})).json();
  const room=rooms.data.find((value:{title:string})=>value.title===`Browser room ${id}`);
  await Promise.all(Array.from({length:55},(_,index)=>fetch(`/v1/rooms/${room.room_id}/messages`,{method:'POST',headers:{...headers,'Idempotency-Key':crypto.randomUUID()},body:JSON.stringify({body:`History ${id} ${index}`})}).then(response=>{if(!response.ok)throw new Error('History seed failed');})));
 },{id});
 await page.getByRole('link',{name:'Back to the city',exact:true}).click();
 await page.getByRole('link',{name:'Rooms',exact:true}).click();
 await page.locator('.room-list').getByRole('button').filter({hasText:`Browser room ${id}`}).click();
 await page.getByRole('button',{name:'Load earlier messages',exact:true}).click();
 await expect(page.getByText(`Persistent browser message ${id}`,{exact:true})).toBeVisible();
 await page.waitForResponse(response=>response.url().includes('/messages?limit=50')&&!response.url().includes('before_cursor')&&response.request().method()==='GET');
 await expect(page.getByText(`Persistent browser message ${id}`,{exact:true})).toBeVisible();
 await page.screenshot({path:'output/playwright/observatory.png',fullPage:true});
 page.once('dialog',dialog=>dialog.accept('Synthetic moderation smoke: inspect this test message.'));
 await page.locator('article').filter({hasText:`Persistent browser message ${id}`}).getByRole('button',{name:'Report',exact:true}).click();
 await expect(page.getByRole('button',{name:'Report escalated',exact:true})).toBeVisible();
 await page.getByRole('button',{name:'Report escalated',exact:true}).click();
 // Owner controls is a different screen: close the room first (the HUD is inert while it is open).
 await page.getByRole('link',{name:'Back to the city',exact:true}).click();
 await page.getByRole('link',{name:'Owner controls',exact:true}).click();
 await expect(page.getByText('owner_escalation',{exact:true}).first()).toBeVisible();
 await page.getByRole('link',{name:'Back to the city',exact:true}).click();
 await page.getByRole('button',{name:'Sign out'}).click();
 await expect(page.getByRole('button',{name:'Sign in',exact:true})).toBeVisible();
 await expect(page.getByRole('link',{name:'Owner controls',exact:true})).toHaveCount(0);
});
