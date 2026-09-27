# Gateway contracts

These tests protect stable behavior exposed by the Manifest gateway. They run
against the built application over HTTP and must not import backend source code
or test helpers.

Run them against a local Manifest instance:

```sh
MANIFEST_BASE_URL=http://127.0.0.1:2099 \
  node --test contracts/gateway/tests/*.test.mjs
```

Pull request CI runs two copies of the suite against the candidate application:

1. The contracts from the pull request's base commit protect existing behavior.
2. The contracts from the pull request validate additions and contract changes.

Removing a contract and its implementation therefore requires two pull
requests. First remove the contract while the implementation still satisfies
the baseline suite. After that merges, remove the implementation.

Keep this suite small and limited to durable public behavior. Implementation
details and provider-specific edge cases belong in the backend test suite.
