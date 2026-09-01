// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {HookPermissions} from "../src/config/HookPermissions.sol";

/// @dev The minimum of source reading a static proof needs: comment stripping, substring search, brace
///      matching, whitespace tokenising and identifier tokenising over `bytes`. Deliberately naive — these
///      files are ~70KB and the searches are few, so clarity beats cleverness — and deliberately
///      string-literal-blind at the comment-stripping stage: no file in src/ carries a comment marker
///      inside a string literal (asserted below, so that stays true).
abstract contract SourceReader is Test {
    /// @dev `vm.readFile` needs `fs_permissions = [{ access = "read", path = "./src" }]` in foundry.toml.
    function _source(string memory path) internal view returns (bytes memory) {
        return _stripComments(bytes(vm.readFile(path)));
    }

    /// @dev Remove `// ...` to end of line and `/* ... */` blocks, so a comment that MENTIONS a forbidden
    ///      identifier (MolePositions does, by design) cannot fail a check aimed at code.
    function _stripComments(bytes memory s) internal pure returns (bytes memory out) {
        out = new bytes(s.length);
        uint256 k;
        uint256 i;
        while (i < s.length) {
            if (i + 1 < s.length && s[i] == "/" && s[i + 1] == "/") {
                while (i < s.length && s[i] != "\n") i++;
            } else if (i + 1 < s.length && s[i] == "/" && s[i + 1] == "*") {
                i += 2;
                while (i + 1 < s.length && !(s[i] == "*" && s[i + 1] == "/")) i++;
                i += 2;
            } else {
                out[k++] = s[i++];
            }
        }
        assembly ("memory-safe") {
            mstore(out, k)
        }
    }

    function _find(bytes memory h, bytes memory n, uint256 from) internal pure returns (bool, uint256) {
        if (n.length == 0 || h.length < n.length) return (false, 0);
        bytes1 first = n[0];
        for (uint256 i = from; i + n.length <= h.length; i++) {
            if (h[i] != first) continue;
            bool ok = true;
            for (uint256 j = 1; j < n.length; j++) {
                if (h[i + j] != n[j]) {
                    ok = false;
                    break;
                }
            }
            if (ok) return (true, i);
        }
        return (false, 0);
    }

    function _contains(bytes memory h, string memory n) internal pure returns (bool found) {
        (found,) = _find(h, bytes(n), 0);
    }

    function _count(bytes memory h, string memory n) internal pure returns (uint256 c) {
        uint256 from;
        while (true) {
            (bool f, uint256 at) = _find(h, bytes(n), from);
            if (!f) break;
            c++;
            from = at + 1;
        }
    }

    function _slice(bytes memory s, uint256 start, uint256 end) internal pure returns (bytes memory out) {
        out = new bytes(end - start);
        for (uint256 i = start; i < end; i++) out[i - start] = s[i];
    }

    /// @dev From the `{` at `open`, the index just past its matching `}`.
    function _matchBrace(bytes memory s, uint256 open) internal pure returns (uint256) {
        require(s[open] == "{", "not a brace");
        uint256 depth;
        for (uint256 i = open; i < s.length; i++) {
            if (s[i] == "{") depth++;
            else if (s[i] == "}") {
                depth--;
                if (depth == 0) return i + 1;
            }
        }
        revert("unbalanced braces");
    }

    /// @dev `function name(` ... up to (not including) the body's `{`. Reverts if absent — a proof about a
    ///      function that does not exist would be vacuous.
    function _header(bytes memory src, string memory kind, string memory name)
        internal
        pure
        returns (bytes memory header, uint256 bodyOpen)
    {
        (bool f, uint256 at) = _find(src, bytes(string.concat(kind, " ", name, "(")), 0);
        require(f, string.concat("not found: ", kind, " ", name));
        (bool fb, uint256 brace) = _find(src, "{", at);
        require(fb, "no body");
        header = _slice(src, at, brace);
        bodyOpen = brace;
    }

    function _body(bytes memory src, string memory kind, string memory name) internal pure returns (bytes memory) {
        (, uint256 open) = _header(src, kind, name);
        return _slice(src, open, _matchBrace(src, open));
    }

    /// @dev From `contract <name> is` through its closing brace, so nothing declared in the same file but
    ///      outside the contract (the oracle interface, a second contract) is mistaken for part of it.
    function _contractBody(bytes memory src, string memory name) internal pure returns (bytes memory) {
        (bool f, uint256 at) = _find(src, bytes(string.concat("contract ", name, " is ")), 0);
        require(f, string.concat("contract not found: ", name));
        (, uint256 open) = _find(src, "{", at);
        return _slice(src, at, _matchBrace(src, open));
    }

    /// @dev `region` with the `{ ... }` block that follows `marker` cut out and the marker itself kept — so
    ///      a branch that is NOT on the exit path drops out of the reading while its condition, which IS
    ///      evaluated on the way past, stays in. Reverts if the marker is absent: the condition is pinned.
    function _withoutBlock(bytes memory region, string memory marker) internal pure returns (bytes memory) {
        (bool f, uint256 at) = _find(region, bytes(marker), 0);
        require(f, string.concat("branch not found, re-audit the exit path: ", marker));
        (bool fb, uint256 open) = _find(region, "{", at);
        require(fb, "branch has no block");
        uint256 close = _matchBrace(region, open);
        return bytes(string.concat(string(_slice(region, 0, open)), string(_slice(region, close, region.length))));
    }

    /// @dev The parameter list of a header: between its first `(` and the first `)`.
    function _params(bytes memory header) internal pure returns (bytes memory) {
        (, uint256 o) = _find(header, "(", 0);
        (, uint256 c) = _find(header, ")", o);
        return _slice(header, o + 1, c);
    }

    /// @dev Everything after the parameter list, with any `returns (...)` clause removed: what is left is
    ///      visibility, mutability and MODIFIERS — the thing the exit-path proof is about.
    function _tail(bytes memory header) internal pure returns (bytes memory tail) {
        (, uint256 o) = _find(header, "(", 0);
        (, uint256 c) = _find(header, ")", o);
        tail = _slice(header, c + 1, header.length);
        (bool fr, uint256 r) = _find(tail, "returns", 0);
        if (fr) {
            (, uint256 ro) = _find(tail, "(", r);
            (, uint256 rc) = _find(tail, ")", ro);
            tail = bytes(string.concat(string(_slice(tail, 0, r)), " ", string(_slice(tail, rc + 1, tail.length))));
        }
    }

    function _isSpace(bytes1 b) internal pure returns (bool) {
        return b == " " || b == "\n" || b == "\t" || b == "\r";
    }

    function _isDigit(bytes1 b) internal pure returns (bool) {
        return b >= "0" && b <= "9";
    }

    function _isIdentStart(bytes1 b) internal pure returns (bool) {
        return (b >= "a" && b <= "z") || (b >= "A" && b <= "Z") || b == "_" || b == "$";
    }

    function _isIdentChar(bytes1 b) internal pure returns (bool) {
        return _isIdentStart(b) || _isDigit(b);
    }

    /// @dev Whitespace tokens of `s`.
    function _tokens(bytes memory s) internal pure returns (string[] memory toks) {
        string[] memory buf = new string[](256);
        uint256 n;
        uint256 i;
        while (i < s.length) {
            while (i < s.length && _isSpace(s[i])) i++;
            uint256 start = i;
            while (i < s.length && !_isSpace(s[i])) i++;
            if (i > start) {
                require(n < buf.length, "too many tokens");
                buf[n++] = string(_slice(s, start, i));
            }
        }
        toks = new string[](n);
        for (uint256 k = 0; k < n; k++) toks[k] = buf[k];
    }

    /// @dev Whitespace runs collapsed to one space, ends trimmed — so a multi-line parameter list compares
    ///      equal to its one-line spelling.
    function _normalizeSpace(bytes memory s) internal pure returns (bytes memory out) {
        string[] memory t = _tokens(s);
        for (uint256 i = 0; i < t.length; i++) {
            out = i == 0 ? bytes(t[i]) : bytes(string.concat(string(out), " ", t[i]));
        }
    }

    /// @dev Every IDENTIFIER in `s`, in source order: names, keywords, types and member names alike —
    ///      anything that is not punctuation, a number literal or a string literal. Number literals are
    ///      consumed whole (`10_000`, `0x38C4`, `1e18`) so their letters never surface as names; string
    ///      literals are skipped (the only one on an exit path is the empty hook data in `_modify`).
    function _identifiers(bytes memory s) internal pure returns (string[] memory ids) {
        string[] memory buf = new string[](512);
        uint256 n;
        uint256 i;
        while (i < s.length) {
            bytes1 c = s[i];
            if (c == "\"" || c == "'") {
                i++;
                while (i < s.length && s[i] != c) {
                    if (s[i] == "\\") i++;
                    i++;
                }
                i++;
            } else if (_isDigit(c)) {
                while (i < s.length && _isIdentChar(s[i])) i++;
            } else if (_isIdentStart(c)) {
                uint256 start = i;
                while (i < s.length && _isIdentChar(s[i])) i++;
                require(n < buf.length, "too many identifiers");
                buf[n++] = string(_slice(s, start, i));
            } else {
                i++;
            }
        }
        ids = new string[](n);
        for (uint256 k = 0; k < n; k++) ids[k] = buf[k];
    }

    function _eq(string memory a, string memory b) internal pure returns (bool) {
        return keccak256(bytes(a)) == keccak256(bytes(b));
    }

    function _hasToken(string[] memory toks, string memory t) internal pure returns (bool) {
        for (uint256 i = 0; i < toks.length; i++) {
            if (_eq(toks[i], t)) return true;
        }
        return false;
    }

    /// @dev Visibility and mutability words are not modifiers. Anything else in a header tail is.
    function _isBaseToken(string memory t) internal pure returns (bool) {
        return _eq(t, "external") || _eq(t, "public") || _eq(t, "internal") || _eq(t, "private") || _eq(t, "view")
            || _eq(t, "pure") || _eq(t, "payable") || _eq(t, "override") || _eq(t, "virtual");
    }

    /// @notice Every token of the header tail must be a base token or one of `allowedModifiers`. This is the
    ///         "zero `whenNotPaused` (or any equivalent) on the exit call graph" assertion, made total: it
    ///         refuses any modifier it was not told about, so a pause modifier under any NAME fails it.
    function _assertOnlyModifiers(bytes memory header, string[] memory allowedModifiers, string memory where)
        internal
        pure
    {
        string[] memory toks = _tokens(_tail(header));
        for (uint256 i = 0; i < toks.length; i++) {
            if (_isBaseToken(toks[i])) continue;
            bool allowed;
            for (uint256 j = 0; j < allowedModifiers.length; j++) {
                if (_eq(toks[i], allowedModifiers[j])) allowed = true;
            }
            assertTrue(allowed, string.concat(where, ": unexpected modifier on the exit path: ", toks[i]));
        }
    }

    /// @notice THE ALLOWLIST. Every identifier in `body` must be one of `allowed` (space-separated): the
    ///         state, helpers, types, keywords, locals, events and errors this exact function is known to
    ///         use. A flag, a helper, a storage read or a call under ANY new name fails it — which is what a
    ///         denylist of known names could never do. Returns how many identifiers were checked.
    function _assertOnlyIdentifiers(bytes memory body, string memory allowed, string memory where)
        internal
        pure
        returns (uint256)
    {
        string[] memory ok = _tokens(bytes(allowed));
        string[] memory ids = _identifiers(body);
        assertGt(ids.length, 0, string.concat(where, ": empty body, nothing proven"));
        for (uint256 i = 0; i < ids.length; i++) {
            assertTrue(_hasToken(ok, ids[i]), string.concat(where, ": unexpected identifier on the exit path: ", ids[i]));
        }
        return ids.length;
    }

    /// @dev The error named by each `revert` in `body`, in source order (a `revert("...")` records whatever
    ///      identifier follows it, which still changes the sequence).
    function _revertTargets(bytes memory body) internal pure returns (string[] memory out) {
        string[] memory ids = _identifiers(body);
        uint256 n;
        for (uint256 i = 0; i < ids.length; i++) {
            if (_eq(ids[i], "revert")) n++;
        }
        out = new string[](n);
        uint256 k;
        for (uint256 i = 0; i < ids.length; i++) {
            if (!_eq(ids[i], "revert")) continue;
            out[k++] = i + 1 < ids.length ? ids[i + 1] : "<end>";
        }
    }

    /// @notice THE REVERT PIN. `body` reverts in exactly these places, with exactly these errors, in this
    ///         order (space-separated) — the complete list of what can stop the function. One more, one
    ///         fewer, or a different error fails it.
    function _assertRevertsAre(bytes memory body, string memory expected, string memory where) internal pure {
        string[] memory want = _tokens(bytes(expected));
        string[] memory got = _revertTargets(body);
        assertEq(got.length, want.length, string.concat(where, ": the number of reverts on the exit path changed"));
        uint256 m = got.length < want.length ? got.length : want.length;
        for (uint256 i = 0; i < m; i++) {
            assertEq(got[i], want[i], string.concat(where, ": a revert on the exit path changed"));
        }
    }

    /// @dev Every external or public function declared in `body`, as `name(parameters)` with the parameter
    ///      list normalised — the contract's whole callable surface, inherited bases aside.
    function _externalSignatures(bytes memory body) internal pure returns (string[] memory sigs) {
        string[] memory buf = new string[](64);
        uint256 n;
        uint256 from;
        while (true) {
            (bool f, uint256 at) = _find(body, "function ", from);
            if (!f) break;
            from = at + 1;
            (, uint256 paren) = _find(body, "(", at);
            (bool fb, uint256 brace) = _find(body, "{", at);
            (bool fs, uint256 semi) = _find(body, ";", at);
            uint256 end = (fb && (!fs || brace < semi)) ? brace : semi;
            bytes memory header = _slice(body, at, end);
            string[] memory tail = _tokens(_tail(header));
            if (!_hasToken(tail, "external") && !_hasToken(tail, "public")) continue;
            buf[n++] =
                string.concat(string(_slice(body, at + 9, paren)), "(", string(_normalizeSpace(_params(header))), ")");
        }
        sigs = new string[](n);
        for (uint256 k = 0; k < n; k++) sigs[k] = buf[k];
    }

    /// @notice THE SURFACE PIN. The external/public functions of `body` are exactly `want` — by name AND
    ///         parameter list. A new entry point under any name, with any parameter type (an address, or a
    ///         struct or bytes that could carry one), fails it; so does a changed or vanished one, and so
    ///         does a `receive`/`fallback`.
    function _assertSurfaceIs(bytes memory body, string[] memory want, string memory who) internal pure {
        string[] memory got = _externalSignatures(body);
        for (uint256 i = 0; i < got.length; i++) {
            assertTrue(
                _hasToken(want, got[i]), string.concat(who, " grew an external function outside the pinned surface: ", got[i])
            );
        }
        for (uint256 i = 0; i < want.length; i++) {
            assertTrue(_hasToken(got, want[i]), string.concat(who, " lost a pinned external function: ", want[i]));
        }
        assertEq(got.length, want.length, string.concat(who, ": the external surface changed size"));
        assertFalse(_contains(body, "receive("), string.concat(who, " grew a receive function"));
        assertFalse(_contains(body, "fallback("), string.concat(who, " grew a fallback function"));
    }

    /// @dev Number of places where `mappingName[` ... `]` is WRITTEN (plain or compound assignment), as
    ///      opposed to read or compared.
    function _writeSites(bytes memory src, string memory mappingName) internal pure returns (uint256 writes) {
        uint256 from;
        while (true) {
            (bool f, uint256 at) = _find(src, bytes(string.concat(mappingName, "[")), from);
            if (!f) break;
            (bool fc, uint256 close) = _find(src, "]", at);
            require(fc, "unbalanced index");
            uint256 i = close + 1;
            while (i < src.length && _isSpace(src[i])) i++;
            bytes1 c = src[i];
            bytes1 d = src[i + 1];
            bool isAssign = c == "=" && d != "=";
            bool isCompound = (c == "+" || c == "-" || c == "*" || c == "/" || c == "|" || c == "&") && d == "=";
            if (isAssign || isCompound) writes++;
            from = at + 1;
        }
    }

    /// @dev Number of places where `.member` is WRITTEN (plain or compound assignment) — `x.member = v`,
    ///      `x.member += v` — as opposed to read or compared (`x.member == v`, `x.member != v`).
    function _memberWrites(bytes memory src, string memory member) internal pure returns (uint256 writes) {
        uint256 from;
        while (true) {
            (bool f, uint256 at) = _find(src, bytes(member), from);
            if (!f) break;
            from = at + 1;
            uint256 i = at + bytes(member).length;
            // `.owner` must end the identifier: `.ownerOf(` is a different name.
            if (_isIdentChar(src[i])) continue;
            while (i < src.length && _isSpace(src[i])) i++;
            bytes1 c = src[i];
            bytes1 d = src[i + 1];
            bool isAssign = c == "=" && d != "=";
            bool isCompound = (c == "+" || c == "-" || c == "*" || c == "/" || c == "|" || c == "&") && d == "=";
            if (isAssign || isCompound) writes++;
        }
    }

    /// @dev Number of places where the state variable `name` — as a whole word, not a member of something
    ///      else — is assigned.
    function _assignSites(bytes memory src, string memory name) internal pure returns (uint256 writes) {
        bytes memory n = bytes(name);
        uint256 from;
        while (true) {
            (bool f, uint256 at) = _find(src, n, from);
            if (!f) break;
            from = at + 1;
            if (at > 0 && (_isIdentChar(src[at - 1]) || src[at - 1] == ".")) continue;
            uint256 i = at + n.length;
            if (i < src.length && _isIdentChar(src[i])) continue;
            while (i < src.length && _isSpace(src[i])) i++;
            if (i + 1 < src.length && src[i] == "=" && src[i + 1] != "=") writes++;
        }
    }

    function _list1(string memory a) internal pure returns (string[] memory l) {
        l = new string[](1);
        l[0] = a;
    }

    function _none() internal pure returns (string[] memory l) {
        l = new string[](0);
    }
}

/// @title ExitPathStaticTest
/// @notice T-5, machine-checked against the SOURCE rather than asserted in prose: (a) the exit ABI carries no
///         recipient, and the whole external surface of both custody contracts is pinned by signature so no
///         entry point can appear under any name; (b) no pause modifier — nor ANY modifier but the owner
///         check — sits on a function reachable from withdraw / withdrawAll / cancel / claim / timeout;
///         (c) every identifier in every exit body is on a per-function ALLOWLIST and every revert on the
///         path is pinned by name and order, so a pause flag, a gate helper or a keeper / oracle / admin /
///         whitelist / clock read under ANY name fails; (d) the position owner is written once, from
///         msg.sender, and never reassigned; (e) the pool whitelist, the stored pool keys and the state the
///         exits read are write-once; (f) nothing in src/ imports or declares pause machinery at all.
///
/// This is the static half of the exit-path claim. test/ExitPath.t.sol is the dynamic half (the same facts
/// exercised against a live PoolManager with every lever hostile), and HookPermissions.t.sol pins the
/// address-bit half (the PoolManager cannot call our hook on removal). Together they are what lets
/// "no bug, key, pause or upgrade can block an exit" be CHECKED rather than believed — with the two honest
/// exceptions named in ExitPath.t.sol: a token that refuses to pay the owner, and an upgrade of the vault.
///
/// Each assertion here was mutation-verified: inserting the forbidden thing into the source turns the
/// relevant test red, and restoring it turns it green again. The table of mutations and the tests each one
/// turned red is in PATCH-PROPOSAL-exit-path.md ("Mutation record"); the first version of this file used a
/// word DENYLIST over the exit bodies and an address-typed-parameter check over the surface, and three
/// mutations survived it (a root-key flag under a novel name, the same gate behind a private helper, a
/// recipient smuggled through a struct) — the allowlist, the revert pin and the surface pin are what turn
/// those red.
contract ExitPathStaticTest is SourceReader {
    string internal constant VAULT = "src/MolePositions.sol";
    string internal constant QUEUE = "src/MoleQueue.sol";

    /// @dev Keywords and value types any exit body may use. `revert`, `require`, `assert`, `assembly`, `try`,
    ///      `delete`, `call`, `new` and every contract-specific name are deliberately NOT here: a body that
    ///      reverts lists `revert` and its own errors itself, and everything else must be named by the one
    ///      function that uses it.
    string internal constant SYNTAX =
        "if else return emit true false storage memory calldata uint256 uint128 uint64 int24 int128 int256 bytes bytes32 bool address";

    function _vault() internal view returns (bytes memory) {
        return _contractBody(_source(VAULT), "MolePositions");
    }

    function _queue() internal view returns (bytes memory) {
        return _contractBody(_source(QUEUE), "MoleQueue");
    }

    /// @dev `unlockCallback` from its opening brace through the end of its Withdraw branch, with the bodies
    ///      of the two branches that are NOT on the exit path (ZapOpen, Open) cut out and their conditions —
    ///      which are evaluated on the way past — kept and pinned. This is exactly the code a withdrawal
    ///      runs inside the PoolManager's unlock.
    function _callbackExitRegion(bytes memory vault) internal pure returns (bytes memory region) {
        (, uint256 open) = _header(vault, "function", "unlockCallback");
        (bool f, uint256 at) = _find(vault, "if (action == Action.Withdraw)", open);
        assertTrue(f, "unlockCallback lost its Withdraw branch");
        (, uint256 bOpen) = _find(vault, "{", at);
        region = _slice(vault, open, _matchBrace(vault, bOpen));
        region = _withoutBlock(region, "if (abi.decode(data[:32], (Action)) == Action.ZapOpen)");
        region = _withoutBlock(region, "if (action == Action.Open)");
    }

    /* ========================================================= (f) no pause machinery anywhere in src/ */

    /// @notice No file under src/ declares, imports or calls pause machinery — under the OpenZeppelin names
    ///         or any obvious cousin. This is the repo-wide version of the exit-path check, so a pause cannot
    ///         arrive in a library the vault delegatecalls into either.
    function test_static_noPauseMachineryAnywhereInSrc() public view {
        Vm.DirEntry[] memory entries = vm.readDir("src", 4);
        uint256 scanned;
        bool sawVault;
        bool sawQueue;
        bool sawRouter;
        bool sawZap;
        bool sawHook;
        for (uint256 i = 0; i < entries.length; i++) {
            if (entries[i].isDir) continue;
            bytes memory p = bytes(entries[i].path);
            if (p.length < 4 || !_contains(p, ".sol")) continue;
            bytes memory src = _source(entries[i].path);
            scanned++;
            assertFalse(_contains(src, "whenNotPaused"), string.concat(entries[i].path, " carries whenNotPaused"));
            assertFalse(_contains(src, "whenPaused"), string.concat(entries[i].path, " carries whenPaused"));
            assertFalse(_contains(src, "Pausable"), string.concat(entries[i].path, " imports or inherits Pausable"));
            assertFalse(_contains(src, "_pause("), string.concat(entries[i].path, " calls _pause"));
            assertFalse(_contains(src, "_unpause("), string.concat(entries[i].path, " calls _unpause"));
            assertFalse(_contains(src, "paused()"), string.concat(entries[i].path, " reads paused()"));
            assertFalse(_contains(src, "emergencyWithdraw"), string.concat(entries[i].path, " has an emergencyWithdraw"));
            // The reader is string-literal-blind; keep src/ free of the two things that would confuse it.
            assertFalse(_contains(src, "\"//"), string.concat(entries[i].path, " has a comment marker inside a string"));
            if (_contains(p, "MolePositions.sol")) sawVault = true;
            if (_contains(p, "MoleQueue.sol")) sawQueue = true;
            if (_contains(p, "MoleRouter.sol")) sawRouter = true;
            if (_contains(p, "ZapLogic.sol")) sawZap = true;
            if (_contains(p, "MoleHook.sol")) sawHook = true;
        }
        // Non-vacuity: the walk actually reached the contracts the claim is about.
        assertTrue(sawVault && sawQueue && sawRouter && sawZap && sawHook, "the source walk missed a contract");
        assertGe(scanned, 11, "fewer source files than expected were scanned");
    }

    /* ==================================================== (b) no modifier but the owner check — vault */

    /// @notice Every function on the vault's exit call graph — `withdrawAll` -> `withdraw` -> `unlockCallback`
    ///         -> `_modify` / `_takePerformanceFee` / `_cutOf` / `_collectTo` — carries NO modifier except the
    ///         owner check on `withdraw`, and that check reads nothing but the stored owner.
    function test_static_vaultExitGraphCarriesNoModifierButTheOwnerCheck() public view {
        bytes memory src = _vault();

        (bytes memory hWithdraw,) = _header(src, "function", "withdraw");
        _assertOnlyModifiers(hWithdraw, _list1("onlyPositionOwner(id)"), "withdraw");
        assertTrue(_hasToken(_tokens(_tail(hWithdraw)), "onlyPositionOwner(id)"), "withdraw lost its owner check");

        (bytes memory hAll,) = _header(src, "function", "withdrawAll");
        _assertOnlyModifiers(hAll, _none(), "withdrawAll");

        (bytes memory hCb,) = _header(src, "function", "unlockCallback");
        _assertOnlyModifiers(hCb, _none(), "unlockCallback");

        (bytes memory hMod,) = _header(src, "function", "_modify");
        _assertOnlyModifiers(hMod, _none(), "_modify");
        (bytes memory hFee,) = _header(src, "function", "_takePerformanceFee");
        _assertOnlyModifiers(hFee, _none(), "_takePerformanceFee");
        (bytes memory hCut,) = _header(src, "function", "_cutOf");
        _assertOnlyModifiers(hCut, _none(), "_cutOf");
        (bytes memory hCol,) = _header(src, "function", "_collectTo");
        _assertOnlyModifiers(hCol, _none(), "_collectTo");

        // The one modifier allowed is itself nothing but the owner check: pinned as text, then as the full
        // identifier set and the one revert it may raise.
        bytes memory ownerCheck = _body(src, "modifier", "onlyPositionOwner");
        assertTrue(
            _contains(ownerCheck, "if (_positions[id].owner != msg.sender) revert NotOwner();"),
            "onlyPositionOwner no longer reads only the stored owner"
        );
        _assertOnlyIdentifiers(
            ownerCheck, string.concat(SYNTAX, " _positions id owner msg sender revert NotOwner _"), "onlyPositionOwner"
        );
        _assertRevertsAre(ownerCheck, "NotOwner", "onlyPositionOwner");
    }

    /* ===================================================== (a) the exit ABI carries no recipient — vault */

    /// @notice `withdraw(uint256 id, uint128 liquidityToRemove)` and `withdrawAll(uint256 id)`: no `address`
    ///         anywhere in either signature. And, totally: the vault's external/public surface is exactly the
    ///         twenty-two functions below, by name and parameter list — so no function, under any name and
    ///         with any parameter type, can be added that sends a position's tokens to a caller-supplied
    ///         address, and only three of the pinned ones take an address at all (none of them moves a token).
    ///
    /// PIN UPDATED 2026-08-24, and here is the whole of why. The 2026-08-23 audit fixes added four external
    /// functions: `withdrawWithMinimums` (a SECOND exit, whose extra parameters are a floor the CALLER
    /// supplies), and three root-key setters — `setPoolLiquidityCap`, `seedPoolLiquidity`, `setEjectionCap` —
    /// that exist because `maxEjectionBps` and the new aggregate `poolLiquidity` counter are otherwise
    /// unreachable on the two proxies that already hold money (F-07 mechanisms C and D). Each was judged
    /// against the two things this pin protects, not merely added to make it green:
    ///   - NONE TAKES AN ADDRESS, so none can name a recipient. The three address-taking functions are still
    ///     `setFeeRecipient`, `transferUpgradeAdmin` and the initializer's struct, exactly as before.
    ///   - NONE IS READ ON THE EXIT. `maxPoolLiquidity` is read only by `_addPoolLiquidity` (the deposit
    ///     side); `maxEjectionBps` only by `rebalance`; `poolLiquidity` is touched on the exit only by
    ///     `_subPoolLiquidity`, which SATURATES at zero and cannot revert. That is proven, not asserted,
    ///     by the identifier allowlists in
    ///     `test_static_vaultExitBodiesReadNoKeeperOracleAdminWhitelistClockOrBound` below: if any of these
    ///     three names ever appears in an exit body, that test goes red.
    /// A setter that could reach the exit would have to be REMOVED, not pinned.
    function test_static_withdrawAbiHasNoRecipientAndNoExternalFunctionCanNameOne() public view {
        bytes memory src = _vault();

        (bytes memory hWithdraw,) = _header(src, "function", "withdraw");
        assertEq(string(_params(hWithdraw)), "uint256 id, uint128 liquidityToRemove", "withdraw's parameters changed");
        (bytes memory hAll,) = _header(src, "function", "withdrawAll");
        assertEq(string(_params(hAll)), "uint256 id", "withdrawAll's parameters changed");
        (bytes memory hMin,) = _header(src, "function", "withdrawWithMinimums");
        assertEq(
            string(_params(hMin)),
            "uint256 id, uint128 liquidityToRemove, uint256 amount0Min, uint256 amount1Min",
            "withdrawWithMinimums' parameters changed"
        );

        string[] memory want = new string[](23);
        want[0] = "initialize(InitParams memory p_)";
        want[1] = "setKeeperExpiry(uint64 expiry)";
        want[2] = "setFeeRecipient(address to)"; // repoints where ERC-6909 fee claims are minted
        want[3] = "setPositionSizeBand(uint128 minLiquidity, uint128 maxLiquidity)";
        want[4] = "setRangeWidthBand(int24 minWidth, int24 maxWidth)";
        want[5] = "setKeeperRevoked(uint256 id, bool revoked)";
        want[6] = "transferUpgradeAdmin(address to)"; // hands over (or burns) the root key
        want[7] = "whitelistPool(PoolKey calldata key)";
        want[8] = "zapOpen(ZapLogic.ZapParams calldata z, uint256 deadline)";
        want[9] =
            "open(PoolKey calldata key, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 amount0Max, uint256 amount1Max, uint256 deadline)";
        want[10] = "withdrawAll(uint256 id)";
        want[11] = "withdraw(uint256 id, uint128 liquidityToRemove)";
        want[12] = "rebalance(uint256 id, int24 newTickLower, int24 newTickUpper)";
        want[13] = "unlockCallback(bytes calldata data)";
        want[14] = "getPosition(uint256 id)";
        want[15] = "ownerOf(uint256 id)";
        want[16] = "positionsOf(address owner)"; // a view
        want[17] = "poolKeyOf(PoolId id)";
        // The second exit. Extra parameters, no extra authority: the floor is the CALLER's own number, so
        // the only person it can ever stop is the person who passed it.
        want[18] = "withdrawWithMinimums(uint256 id, uint128 liquidityToRemove, uint256 amount0Min, uint256 amount1Min)";
        // F-07 mechanism D: the aggregate per-pool ceiling and its one-off seeding, both root-key-only.
        // Read on the deposit side only — see the header above.
        want[19] = "setPoolLiquidityCap(uint128 cap)";
        want[20] = "seedPoolLiquidity(PoolId poolId, uint128 total)";
        // F-07 mechanism C: `maxEjectionBps` is initializer-set and ships DISABLED on both live proxies,
        // so without a setter the cap that answers the finding is unreachable there. Read by `rebalance`
        // only.
        want[21] = "setEjectionCap(uint16 bps)";
        // ROTATION, not authority. `keeper` was initializer-only and `setKeeperExpiry` can DISABLE a
        // keeper but not REPLACE one, so recovering from a leaked keeper key meant shipping a new
        // implementation through `upgradeAdmin` — the key that can rewrite `withdraw`. An incident on the
        // least trusted key in the system should not force the operator to reach for the most trusted
        // one. It takes an address, which is what this pin is watching for, and it is admitted because
        // that address is a ROLE and never a payout target: `keeper` is read by `rebalance` and by the
        // `onlyKeeper` modifier, and by nothing on the exit path — which
        // test_static_vaultExitBodiesReadNoKeeperOracleAdminWhitelistClockOrBound proves separately.
        want[22] = "setKeeper(address to)";
        _assertSurfaceIs(src, want, "the vault");

        // NON-VACUITY OF THE "no recipient" HALF: exactly four of the twenty-three spell `address` in
        // their parameter list, and the count is pinned so a fifth cannot arrive without this line
        // moving. Three are admin plumbing (setFeeRecipient, transferUpgradeAdmin, setKeeper) and the
        // fourth is a view that returns ids. Neither of the two exits is among them.
        //
        // EVERY ONE OF THE THREE NAMES A ROLE, NEVER A PAYOUT TARGET, and that distinction is the whole
        // point of counting: `feeRecipient` is where ERC-6909 fee CLAIMS are minted rather than where
        // principal is sent, `upgradeAdmin` is the root key, and `keeper` is read only by `rebalance`
        // and the `onlyKeeper` modifier. That none of them is reachable from the exit is proved
        // separately by test_static_vaultExitBodiesReadNoKeeperOracleAdminWhitelistClockOrBound; this
        // line only stops a FOURTH kind of address arriving unnoticed.
        uint256 withAddress;
        for (uint256 i = 0; i < want.length; i++) {
            if (_contains(bytes(want[i]), "address ")) withAddress++;
        }
        assertEq(withAddress, 4, "the number of address-taking entry points changed");
        assertTrue(_hasToken(want, "setFeeRecipient(address to)"), "setFeeRecipient is no longer one of them");
        assertTrue(_hasToken(want, "transferUpgradeAdmin(address to)"), "transferUpgradeAdmin is no longer one of them");
        assertTrue(_hasToken(want, "positionsOf(address owner)"), "positionsOf is no longer one of them");

        // P-69's forbidden primitive, by name, anywhere in the vault.
        assertFalse(_contains(src, "rescue"), "the vault grew a rescue function");
        assertFalse(_contains(src, "sweep"), "the vault grew a sweep function");
        assertFalse(_contains(src, "emergency"), "the vault grew an emergency function");
    }

    /* ================================== (c) the exit bodies read no keeper / oracle / admin / whitelist */

    /// @notice The BODIES of the exit graph — `withdrawAll`, `withdraw`, `withdrawWithMinimums`, the shared
    ///         `_withdraw`, the two hops it makes (`_subPoolLiquidity`, `_guardedUnlock`), the callback's
    ///         exit region, and the four helpers it calls — use ONLY the identifiers listed for each, and
    ///         revert ONLY where and with what is pinned for each. So none may reach the keeper or any
    ///         keeper bound, the oracle, the root key, the whitelist, the clock, the size band, the new
    ///         aggregate liquidity cap, a pause flag under any name, a new helper, a `require` or an
    ///         `assert`.
    ///
    /// THE GRAPH GREW THREE HOPS ON 2026-08-24, and this test FOLLOWS them rather than blessing them. The
    /// audit fixes split the exit into `withdraw`/`withdrawWithMinimums` -> `_withdraw`, and `_withdraw`
    /// now calls `_subPoolLiquidity` (the F-07 mechanism D counter) and `_guardedUnlock` (the unlock-
    /// initiator sentinel) instead of `poolManager.unlock` directly. Following a hop is only legitimate if
    /// the hop is pinned as hard as the caller was, so each of the three gets its own total allowlist and
    /// its own revert pin below. What that buys, concretely:
    ///   - `_subPoolLiquidity` CANNOT REVERT — pinned to zero reverts, and its body is pinned as text to
    ///     the saturating form. A checked `-=` there would brick every exit on a vault upgraded in place
    ///     over an existing book, which is exactly the reason the saturation is written that way.
    ///   - `_guardedUnlock` is the ONE place on the exit path where `assembly` is permitted, and only
    ///     because the total allowlist makes it a narrower statement than prose could be: the only opcode
    ///     it may name is `tstore` on `_UNLOCK_SLOT`. `sload`, `sstore`, `extcodesize`, `call`, `delegatecall`
    ///     — any of them, under any name — fail the allowlist. Both assembly blocks are pinned as text too.
    ///   - `_withdraw` may revert in exactly three places, all of them the caller's own arithmetic:
    ///     ZeroLiquidity, InsufficientLiquidity, and the caller-supplied floor. No fourth can appear.
    function test_static_vaultExitBodiesReadNoKeeperOracleAdminWhitelistClockOrBound() public view {
        bytes memory src = _vault();

        bytes memory all = _body(src, "function", "withdrawAll");
        _assertOnlyIdentifiers(all, string.concat(SYNTAX, " withdraw id _positions liquidity"), "withdrawAll");
        _assertRevertsAre(all, "", "withdrawAll");

        // The two public exits are now thin: each forwards to `_withdraw` and does nothing else. Pinned as
        // text as well as by allowlist, so neither can grow a gate of its own above the shared body.
        bytes memory w = _body(src, "function", "withdraw");
        _assertOnlyIdentifiers(w, string.concat(SYNTAX, " _withdraw id liquidityToRemove"), "withdraw");
        _assertRevertsAre(w, "", "withdraw");
        assertTrue(_contains(w, "_withdraw(id, liquidityToRemove, 0, 0);"), "withdraw no longer exits with no floor");

        bytes memory wm = _body(src, "function", "withdrawWithMinimums");
        _assertOnlyIdentifiers(
            wm, string.concat(SYNTAX, " _withdraw id liquidityToRemove amount0Min amount1Min"), "withdrawWithMinimums"
        );
        _assertRevertsAre(wm, "", "withdrawWithMinimums");
        assertTrue(
            _contains(wm, "_withdraw(id, liquidityToRemove, amount0Min, amount1Min);"),
            "withdrawWithMinimums no longer forwards the caller's own floor"
        );

        // THE SHARED EXIT BODY. Everything the old `withdraw` body proved is proved here instead.
        bytes memory inner = _body(src, "function", "_withdraw");
        _assertOnlyIdentifiers(
            inner,
            string.concat(
                SYNTAX,
                " Position p _positions id liquidityToRemove revert ZeroLiquidity liquidity InsufficientLiquidity",
                " _subPoolLiquidity poolId res _guardedUnlock abi encode Action Withdraw owner amount0 amount1",
                " amount0Min amount1Min decode WithdrawBelowMinimum PositionWithdrawn"
            ),
            "_withdraw"
        );
        _assertRevertsAre(inner, "ZeroLiquidity InsufficientLiquidity WithdrawBelowMinimum", "_withdraw");
        // The floor is compared against what came BACK, and against nothing else.
        assertTrue(
            _contains(inner, "if (amount0 < amount0Min || amount1 < amount1Min) revert WithdrawBelowMinimum();"),
            "the exit's only price check is no longer the caller's own floor"
        );

        // HOP 1: the aggregate counter. Saturating, so it cannot revert; pinned to zero reverts AND to the
        // exact saturating expression, because a checked subtraction here would brick every pre-upgrade
        // position's exit.
        bytes memory sub = _body(src, "function", "_subPoolLiquidity");
        _assertOnlyIdentifiers(
            sub, string.concat(SYNTAX, " unchecked uint128 cur poolLiquidity pid amount"), "_subPoolLiquidity"
        );
        _assertRevertsAre(sub, "", "_subPoolLiquidity");
        assertTrue(
            _contains(sub, "poolLiquidity[pid] = amount >= cur ? 0 : cur - amount;"),
            "the exit's liquidity decrement no longer saturates at zero"
        );
        // And the CAP is not read here: the ceiling belongs to the deposit side only.
        assertFalse(_contains(sub, "maxPoolLiquidity"), "the exit reads the aggregate liquidity cap");

        // HOP 2: the unlock sentinel. The only assembly on the exit path, and the allowlist above is what
        // makes that safe — `tstore` is the one opcode it may name.
        bytes memory gu = _body(src, "function", "_guardedUnlock");
        _assertOnlyIdentifiers(
            gu,
            string.concat(SYNTAX, " slot _UNLOCK_SLOT assembly tstore res poolManager unlock data"),
            "_guardedUnlock"
        );
        _assertRevertsAre(gu, "", "_guardedUnlock");
        assertTrue(_contains(gu, "tstore(slot, 1)"), "the unlock sentinel is no longer armed");
        assertTrue(_contains(gu, "tstore(slot, 0)"), "the unlock sentinel is no longer cleared");
        assertEq(_count(gu, "assembly"), 2, "the sentinel grew an assembly block");

        bytes memory region = _callbackExitRegion(src);
        _assertOnlyIdentifiers(
            region,
            string.concat(
                SYNTAX,
                " msg sender poolManager revert NotPoolManager abi decode data Action ZapOpen action id owner",
                " liquidityDelta newLower newUpper amount0Max amount1Max Position p _positions PoolKey key _pools",
                " poolId Open Withdraw BalanceDelta delta exitFees _modify tickLower tickUpper exitCut0 exitCut1",
                " _takePerformanceFee a0 a1 _collectTo toBalanceDelta encode",
                // The unlock-initiator sentinel, added 2026-08-23. It reads a TRANSIENT slot this contract
                // set two frames earlier in the same transaction — not storage, not an admin flag, not a
                // clock — and `tload` is the only opcode the allowlist lets it name.
                " slot _UNLOCK_SLOT armed assembly tload UnexpectedCallback"
            ),
            "unlockCallback (exit region)"
        );
        _assertRevertsAre(region, "NotPoolManager UnexpectedCallback", "unlockCallback (exit region)");
        assertTrue(_contains(region, "armed := tload(slot)"), "the callback's sentinel read changed shape");
        assertEq(_count(region, "assembly"), 1, "the callback's exit region grew an assembly block");
        // The three calls the branch makes, in order, and the payout target: the STORED owner, read through
        // the position — pinned as text so a refactor to `owner` (the decoded calldata value) or to a
        // parameter is caught.
        assertTrue(_contains(region, "_modify(key, p.tickLower, p.tickUpper, liquidityDelta, id)"), "the Withdraw branch no longer burns the stored range");
        assertTrue(_contains(region, "_takePerformanceFee(key, exitFees, id)"), "the Withdraw branch no longer takes the cut from the fee component");
        assertTrue(
            _contains(region, "_collectTo(key, delta - toBalanceDelta(int128(exitCut0), int128(exitCut1)), p.owner)"),
            "the Withdraw branch no longer pays p.owner"
        );

        bytes memory mod = _body(src, "function", "_modify");
        _assertOnlyIdentifiers(
            mod,
            string.concat(
                SYNTAX,
                " BalanceDelta callerDelta feesAccrued poolManager modifyLiquidity key ModifyLiquidityParams",
                " tickLower lower tickUpper upper liquidityDelta salt id"
            ),
            "_modify"
        );
        _assertRevertsAre(mod, "", "_modify");

        bytes memory fee = _body(src, "function", "_takePerformanceFee");
        _assertOnlyIdentifiers(
            fee,
            string.concat(
                SYNTAX,
                " performanceFeeBps cut0 _cutOf feesAccrued amount0 cut1 amount1 poolManager mint feeRecipient",
                " key currency0 toId currency1 PerformanceFeeTaken id"
            ),
            "_takePerformanceFee"
        );
        _assertRevertsAre(fee, "", "_takePerformanceFee");
        // And the fee leg is a MINT (a credit that calls no token and no recipient), never a take.
        assertEq(_count(fee, "poolManager.mint("), 2, "the fee leg no longer mints exactly one credit per currency");
        assertFalse(_contains(fee, "take("), "the fee leg moves tokens - a hostile token could block the exit");
        assertFalse(_contains(fee, "transfer"), "the fee leg transfers - a hostile token could block the exit");

        bytes memory cut = _body(src, "function", "_cutOf");
        _assertOnlyIdentifiers(cut, string.concat(SYNTAX, " feeComponent performanceFeeBps"), "_cutOf");
        _assertRevertsAre(cut, "", "_cutOf");

        bytes memory col = _body(src, "function", "_collectTo");
        _assertOnlyIdentifiers(
            col,
            string.concat(SYNTAX, " d0 delta amount0 d1 amount1 a0 poolManager take key currency0 to a1 currency1"),
            "_collectTo"
        );
        _assertRevertsAre(col, "", "_collectTo");
    }

    /* ================================================== (d) owner written once, from msg.sender, never again */

    /// @notice T-5 (c): the position owner is set exactly at creation, from `msg.sender`, at both entry points,
    ///         and is never reassigned anywhere. No transfer, no setter, no rescue can change who is paid.
    ///
    /// PIN UPDATED 2026-08-24. The old form was `_count(src, "owner:") == 2`, which read as "the only two
    /// `owner:` field initializers in the vault are the two Position literals". The rebalance arithmetic
    /// moved into `ZapLogic.rebalance` for EIP-170 headroom, and its parameter struct carries an `owner:`
    /// field too — so the count is now three. The PROPERTY is unchanged and is still stated totally: every
    /// `owner:` in the file is pinned by its exact right-hand side, and the total is pinned so a fourth
    /// cannot appear unpinned. The third one reads `p.owner` — the STORED owner, out of storage — which is
    /// the one source this contract is allowed to take a payout target from; a literal spelling
    /// `owner: msg.sender` in that struct, or `owner:` set from a parameter or a decoded payload anywhere,
    /// still fails.
    function test_static_positionOwnerIsWrittenOnceFromMsgSenderAndNeverReassigned() public view {
        bytes memory src = _vault();
        assertEq(_count(src, "owner: msg.sender"), 2, "the owner is not set from msg.sender at exactly open and zapOpen");
        assertEq(_count(src, "Position({"), 2, "the vault builds a Position literal somewhere new");
        assertEq(_count(src, "owner: p.owner"), 1, "the rebalance payload no longer reads the stored owner");
        assertEq(_count(src, "owner:"), 3, "a struct literal sets an owner from something else");
        assertEq(_memberWrites(src, ".owner"), 0, "a position's owner is reassigned somewhere");
    }

    /* ========================================== (e) whitelist and stored pool keys are write-once, append-only */

    /// @notice A position's exit reads `_pools[p.poolId]` for the key it burns against. That mapping is written
    ///         in exactly one place (`whitelistPool`, guarded by `PoolAlreadyWhitelisted`), the whitelist flag
    ///         is written exactly once and only ever to `true`, and neither is ever deleted — so no later
    ///         admission, and no admin, can swap the key out from under an open position.
    function test_static_whitelistAndPoolKeysAreWriteOnceAndNeverDeleted() public view {
        bytes memory src = _vault();
        assertEq(_writeSites(src, "isWhitelisted"), 1, "isWhitelisted is written in more than one place");
        assertEq(_count(src, "isWhitelisted[id] = true;"), 1, "the one whitelist write is not `= true`");
        assertEq(_writeSites(src, "_pools"), 1, "_pools is written in more than one place");
        assertEq(_count(src, "_pools[id] = key;"), 1, "the one pool-key write is not the admission write");
        assertFalse(_contains(src, "delete isWhitelisted"), "a whitelist entry can be deleted");
        assertFalse(_contains(src, "delete _pools"), "a stored pool key can be deleted");
        assertTrue(
            _contains(src, "if (isWhitelisted[id]) revert PoolAlreadyWhitelisted();"),
            "re-admission of a pool id is no longer refused"
        );
    }

    /// @notice The other state an exit reads is assigned exactly once, in `initialize`, and nowhere else: the
    ///         PoolManager the vault burns against and takes from, the fee rate, and — for the queue — the
    ///         pool key it pays in and the two durations that bound the lock window. No setter, and no other
    ///         function's body, can repoint an exit at a contract that reverts or stretch the window.
    function test_static_exitStateIsWrittenOnlyAtInitialization() public view {
        bytes memory vault = _vault();
        assertEq(_assignSites(vault, "poolManager"), 1, "the vault's poolManager is assigned outside initialize");
        assertEq(_assignSites(vault, "performanceFeeBps"), 1, "the vault's fee rate is assigned outside initialize");
        bytes memory queue = _queue();
        assertEq(_assignSites(queue, "key"), 1, "the queue's pool key is assigned outside initialize");
        assertEq(_assignSites(queue, "epochDuration"), 1, "the queue's epoch duration is assigned outside initialize");
        assertEq(_assignSites(queue, "maxEpochLife"), 1, "the queue's lock bound is assigned outside initialize");
        // Non-vacuity: the one assignment of each is the initializer's.
        assertTrue(_contains(_body(vault, "function", "initialize"), "poolManager = pm_;"), "the vault initializer changed");
        assertTrue(_contains(_body(queue, "function", "initialize"), "maxEpochLife = _maxEpochLife;"), "the queue initializer changed");
    }

    /* ======================================================= (a)(b)(c) again, for the queue's three exits */

    /// @notice `cancel`, `claim`, `timeout` and the helpers they call carry no modifier at all, use only the
    ///         identifiers listed for each and revert only where pinned — so they read no oracle, no
    ///         PoolManager, no root key, no settlement machinery, and no flag under any name: a dead settler,
    ///         a dead oracle or a burned admin leaves every one of them callable. And the queue's whole
    ///         external surface is pinned, so no payout under any name can take a payee.
    function test_static_queueExitGraphCarriesNoModifierAndReadsNoOracleNoPoolNoAdmin() public view {
        bytes memory src = _queue();

        string[7] memory graph =
            ["cancel", "claim", "timeout", "_phase", "_push", "_rawTransfer", "_requireMovableCurrency"];
        for (uint256 i = 0; i < graph.length; i++) {
            (bytes memory h,) = _header(src, "function", graph[i]);
            _assertOnlyModifiers(h, _none(), graph[i]);
        }

        bytes memory cancelBody = _body(src, "function", "cancel");
        _assertOnlyIdentifiers(
            cancelBody,
            string.concat(
                SYNTAX,
                " _phase e Phase Open revert WrongPhase Order o orders index owner msg sender NotOrderOwner withdrawn",
                " AlreadyWithdrawn Epoch ep epochs zeroForOne totalIn0 amountIn totalIn1 _push key currency0 currency1",
                " OrderCancelled"
            ),
            "cancel"
        );
        _assertRevertsAre(cancelBody, "WrongPhase NotOrderOwner AlreadyWithdrawn", "cancel");

        bytes memory claimBody = _body(src, "function", "claim");
        _assertOnlyIdentifiers(
            claimBody,
            string.concat(
                SYNTAX,
                " refunded Epoch ep epochs e Order o orders index owner msg sender revert NotOrderOwner withdrawn",
                " AlreadyWithdrawn phase Phase Refunding amountOut amountIn _push zeroForOne key currency0 currency1",
                " Settled FullMath mulDiv out0 totalIn0 refund0 out1 totalIn1 refund1 WrongPhase Claimed"
            ),
            "claim"
        );
        _assertRevertsAre(claimBody, "NotOrderOwner AlreadyWithdrawn WrongPhase", "claim");

        bytes memory timeoutBody = _body(src, "function", "timeout");
        _assertOnlyIdentifiers(
            timeoutBody,
            string.concat(
                SYNTAX,
                " Epoch ep epochs e phase Phase Open currentEpoch revert WrongPhase block timestamp epochStartedAt",
                // `freezeDuration` was added to the frozen-epoch bound by the F-06 fix: `timeout` used to
                // unlock on the SAME second as lenient `settle`, so the set of moments where the fallback
                // could run and settle could not was EMPTY, and any participant who disliked the cross
                // could veto a settleable batch by racing timeout first. Reading it here is admitted to
                // this allowlist deliberately, and only because it is inert: `freezeDuration` is written
                // ONLY in `initialize` (MoleQueue.sol:237), has NO setter anywhere, is required non-zero
                // (:213), and `maxEpochLife > freezeDuration` is enforced at construction (:231). So no
                // admin can move it, it cannot revert, and the delay it adds to the escape hatch is
                // bounded by construction — the escrow is reclaimable at
                // `frozenAt + maxEpochLife + freezeDuration` at the very latest. A MUTABLE duration here
                // would be a different matter entirely: it could be raised to trap an epoch forever, and
                // that is exactly what this allowlist exists to catch. If a setter for it ever appears,
                // this entry must come back out.
                " epochDuration maxEpochLife freezeDuration NotTimedOut Refunding EpochTimedOut Frozen frozenAt"
            ),
            "timeout"
        );
        // Pin the inertness the entry above depends on, so the two facts cannot drift apart: a setter for
        // `freezeDuration` would make the allowlist entry unsafe without touching this test at all.
        // (`freezeDuration =` would also match the `_freezeDuration == 0` guard, so pin the write form.)
        assertEq(
            _count(src, "freezeDuration = _freezeDuration;"),
            1,
            "freezeDuration is no longer written exactly once by initialize"
        );
        assertEq(_count(src, "setFreezeDuration"), 0, "freezeDuration grew a setter - the timeout allowlist entry above is now unsafe");
        _assertRevertsAre(timeoutBody, "WrongPhase NotTimedOut WrongPhase NotTimedOut", "timeout");

        bytes memory phaseBody = _body(src, "function", "_phase");
        _assertOnlyIdentifiers(
            phaseBody,
            string.concat(
                SYNTAX, " Epoch ep epochs e phase Phase Open currentEpoch block timestamp epochStartedAt epochDuration Frozen"
            ),
            "_phase"
        );
        _assertRevertsAre(phaseBody, "", "_phase");

        bytes memory pushBody = _body(src, "function", "_push");
        _assertOnlyIdentifiers(pushBody, string.concat(SYNTAX, " amount _rawTransfer c to"), "_push");
        _assertRevertsAre(pushBody, "", "_push");

        bytes memory rawBody = _body(src, "function", "_rawTransfer");
        _assertOnlyIdentifiers(
            rawBody,
            string.concat(
                SYNTAX,
                " ok ret Currency unwrap c call abi encodeWithSelector IERC20Minimal transfer selector to amount length",
                " decode revert TransferFailed",
                // F-03's payout-side guard, added 2026-08-23. Followed into its own body below rather than
                // waved through here.
                " _requireMovableCurrency"
            ),
            "_rawTransfer"
        );
        _assertRevertsAre(rawBody, "TransferFailed", "_rawTransfer");

        // THE ONE NEW HOP ON THE QUEUE'S EXIT, AND WHY IT IS NOT A TRAP. `_requireMovableCurrency` puts a
        // REVERT on the payout path, which is normally the thing this file exists to forbid, so it was
        // judged rather than pinned:
        //   - It can only fire when `Currency.unwrap(c).code.length == 0`. `initialize` already refuses a
        //     codeless currency at deploy (`UnsupportedCurrency`, asserted below), and under Cancun's
        //     EIP-6780 an account that was created in an earlier transaction can NEVER lose its code. So
        //     for every queue that can exist, this cannot fire on a legitimate payout.
        //   - When it does fire, the token is provably gone and the transfer it guards would have moved
        //     nothing while marking the order withdrawn. Reverting strands nothing that was not already
        //     unreachable; the old behaviour paid the honest side zero and closed their claim forever.
        //   - `_push` short-circuits on a zero amount BEFORE reaching it, so a dead currency0 cannot block
        //     a currency1-only payout. That ordering is pinned as text.
        // Its body is then pinned totally, so nothing else can be smuggled in behind the same name.
        bytes memory movable = _body(src, "function", "_requireMovableCurrency");
        _assertOnlyIdentifiers(
            movable,
            string.concat(SYNTAX, " Currency unwrap c code length revert UnsupportedCurrency"),
            "_requireMovableCurrency"
        );
        _assertRevertsAre(movable, "UnsupportedCurrency", "_requireMovableCurrency");
        assertTrue(
            _contains(movable, "if (Currency.unwrap(c).code.length == 0) revert UnsupportedCurrency();"),
            "the payout-side currency guard tests something other than the currency having code"
        );
        assertTrue(_contains(pushBody, "if (amount == 0) return;"), "a zero-amount payout no longer short-circuits");
        assertTrue(
            _contains(_body(src, "function", "initialize"), "revert UnsupportedCurrency();"),
            "the queue no longer refuses a currency it cannot move at deploy, so the payout guard became reachable"
        );

        // The queue's entire external surface, pinned. Only `initialize` and `transferUpgradeAdmin` take an
        // address (admin plumbing); no exit names a payee, and nothing can be added that does.
        //
        // PIN UPDATED 2026-08-24 with the five entry points the F-04 settlement-guard fix added: one
        // root-key setter and four views of what it set. Judged, not waved through — none takes an
        // address, so none can name a payee; and none of `shortTwapWindow`, `maxOracleStaleness`,
        // `maxClearingJumpTicks` or `minSettleLiquidity` appears in `cancel`, `claim`, `timeout`,
        // `_phase`, `_push`, `_rawTransfer` or `_requireMovableCurrency`, which the total identifier
        // allowlists above prove rather than assert. They bind the SETTLER, and a settler that refuses is
        // exactly what `timeout` exists to survive.
        // PIN UPDATED AGAIN, same day, with the ONE view the clearing-anchor fix added. `clearingJumpAllowance`
        // takes no argument and no address, so it cannot name a payee; it reads `maxClearingJumpTicks`,
        // `lastClearingAt` and `maxEpochLife` and returns a number, and it appears in `settle`'s guard and
        // nowhere on any exit — which the total identifier allowlists for `cancel`, `claim`, `timeout`,
        // `_phase`, `_push`, `_rawTransfer` and `_requireMovableCurrency` above prove rather than assert.
        // It exists because a refusal a settler cannot explain is a refusal nobody can act on.
        string[] memory want = new string[](18);
        want[0] =
            "initialize(IPoolManager _poolManager, IMoleOracle _oracle, PoolKey memory _key, uint32 _epochDuration, uint32 _freezeDuration, uint32 _maxEpochLife, uint32 _twapWindow, int24 _maxTwapDeviationTicks, uint16 _maxResidualSlippageBps, address _upgradeAdmin)";
        want[1] = "transferUpgradeAdmin(address to)";
        want[2] = "place(bool zeroForOne, uint128 amountIn)";
        want[3] = "cancel(uint64 e, uint256 index)";
        want[4] = "freeze()";
        want[5] = "settle(uint64 e)";
        want[6] = "timeout(uint64 e)";
        want[7] = "claim(uint64 e, uint256 index)";
        want[8] = "refundOf(uint64 e, uint256 index)";
        want[9] = "phaseOf(uint64 e)";
        want[10] = "orderCount(uint64 e)";
        want[11] = "unlockCallback(bytes calldata data)";
        want[12] =
            "setSettlementGuards(uint32 _shortTwapWindow, uint32 _maxOracleStaleness, int24 _maxClearingJumpTicks, uint128 _minSettleLiquidity)";
        want[13] = "effectiveShortTwapWindow()";
        want[14] = "effectiveMaxOracleStaleness()";
        want[15] = "effectiveMaxClearingJumpTicks()";
        want[16] = "effectiveMinSettleLiquidity()";
        want[17] = "clearingJumpAllowance()";
        _assertSurfaceIs(src, want, "the queue");

        // Same non-vacuity check as the vault's surface: exactly two of the queue's eighteen entry points
        // spell `address`, both of them admin plumbing, and the count is pinned so a third cannot arrive
        // quietly. No payout leg has ever taken one and none can be added that does.
        uint256 withAddress;
        for (uint256 i = 0; i < want.length; i++) {
            if (_contains(bytes(want[i]), "address ")) withAddress++;
        }
        assertEq(withAddress, 2, "the queue's number of address-taking entry points changed");

        // Every payout leg names the stored owner, never msg.sender or a parameter: five pushes (in-kind,
        // two output legs, two Q-3 refund legs) and the event, all on `o.owner`.
        assertEq(_count(claimBody, "_push("), 5, "claim's payout legs changed in number");
        assertEq(_count(claimBody, ", o.owner, "), 6, "claim no longer pays the stored order owner on every leg");
        assertFalse(_contains(claimBody, "msg.sender,"), "claim pays msg.sender somewhere");
        assertTrue(_contains(cancelBody, ", o.owner, o.amountIn)"), "cancel no longer returns the escrow to the stored owner");

        // timeout is permissionless by construction: nothing in it compares msg.sender to anything.
        assertFalse(_contains(timeoutBody, "msg.sender"), "timeout grew a caller check");
    }

    /* ======================================== the exit contracts inherit nothing this file cannot see */

    /// @notice The two custody contracts inherit exactly the three bases they are known to — the v4 callback
    ///         interface and OpenZeppelin's initializer/UUPS plumbing, neither of which carries a pause or an
    ///         exit — and each file declares exactly one contract and no library. Pinned because every other
    ///         check in this file reads ONE contract body: a base contract is the one place an extra function
    ///         or modifier could arrive without appearing in it.
    function test_static_exitContractsInheritOnlyTheKnownBases() public view {
        bytes memory vault = _source(VAULT);
        assertTrue(
            _contains(vault, "contract MolePositions is IUnlockCallback, Initializable, UUPSUpgradeable {"),
            "MolePositions' inheritance list changed - re-audit the exit graph across the new base"
        );
        assertEq(_count(vault, "\ncontract "), 1, "MolePositions.sol declares more than one contract");
        assertFalse(_contains(vault, "abstract contract"), "MolePositions.sol grew an abstract base");
        assertFalse(_contains(vault, "\nlibrary "), "MolePositions.sol grew a library");
        bytes memory queue = _source(QUEUE);
        assertTrue(
            _contains(queue, "contract MoleQueue is IUnlockCallback, Initializable, UUPSUpgradeable {"),
            "MoleQueue's inheritance list changed - re-audit the exit graph across the new base"
        );
        assertEq(_count(queue, "\ncontract "), 1, "MoleQueue.sol declares more than one contract");
        assertFalse(_contains(queue, "abstract contract"), "MoleQueue.sol grew an abstract base");
        assertFalse(_contains(queue, "\nlibrary "), "MoleQueue.sol grew a library");
    }

    /* ========================================================= the address-bit half, tied to this file */

    /// @notice The bitmap the vault pins clears every remove-liquidity bit, and the vault's initializer proves
    ///         it for whatever is pinned — so the static and the structural halves of the claim meet here.
    function test_static_hookBitmapClearsTheRemovePathAndTheVaultProvesItAtInit() public view {
        assertEq(HookPermissions.REQUIRED_FLAGS & HookPermissions.WITHDRAWAL_PATH_MASK, 0, "a remove bit is mined");
        bytes memory src = _vault();
        assertTrue(
            _contains(src, "if (!HookPermissions.withdrawalIsUnblockable(hook_)) revert WithdrawalWouldBeBlockable();"),
            "the initializer no longer refuses a pin that could block a withdrawal"
        );
    }
}
