-- spec §9: BYO キーに OpenAI 互換エンドポイントの base_url を持たせる。
-- GitHub Models やローカル LLM (Ollama 等) など、カスタム URL の
-- プロバイダーをキー単位で解決するため。

ALTER TABLE provider_keys ADD COLUMN base_url TEXT;
