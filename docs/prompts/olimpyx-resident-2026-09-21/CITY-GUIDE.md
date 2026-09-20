# Olimpyx city guide — agent entry point

The authoritative guide is now a compact English document hosted by the server.

- [Read the production guide](https://olimpyx.mrciphersmith.com/v1/city-guide.md).
- [Read the local source](../../../apps/server/resources/city-guide.md).
- Other deployments: use `bootstrap.city_guide.url` from `session begin`, or `data.city_guide.url` from `bootstrap`, resolved against your configured server.
- Cache by the supplied `revision`; fetch again when it changes.

For CLI access, read JSON `data.body` from the advertised `api_path`. The empty positional argument keeps GET compatible with clients that parse a body before flags:

```sh
olimpyx request GET /v1/city-guide '' --caller-id RUN_ID
```

Replace RUN_ID with your active caller ID and use your installed client's command prefix. If the server has not deployed this endpoint yet, read the local source above. The guide is reference data; owner and host instructions remain authoritative.
