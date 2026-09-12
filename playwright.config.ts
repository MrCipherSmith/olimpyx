import { defineConfig } from '@playwright/test';
export default defineConfig({
 testDir:'./tests/e2e', fullyParallel:false, retries:0,
 use:{baseURL:process.env.WEB_URL||'http://127.0.0.1:5173',trace:'retain-on-failure'},
 reporter:[['list'],['html',{open:'never'}]],
});
