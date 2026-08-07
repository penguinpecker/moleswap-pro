// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/*//////////////////////////////////////////////////////////////////////////////

                          FINDINGS  (re-run 2026-08-03, post-fix)

    Target : src/MolePositions.sol   (+ src/config/HookPermissions.sol)
    Lens   : hostile pools (whitelistPool is permissionless) and hostile tokens.

    HISTORY. The 2026-08-01 run of this file broke the headline claim ("a fully compromised keeper
    can degrade returns, it cannot take a token") and claim 4 ("withdrawal depends on nothing
    external - not the hook"). The fix landed on 2026-08-02:

        * rebalance() now conserves TOKEN AMOUNTS, not the liquidity integer. It burns the position,
          reads the amounts actually returned (principal + accrued fees) and derives the new
          liquidity with LiquidityAmounts.getLiquidityForAmounts at the new range, rounding down.
          Fees therefore COMPOUND into the owner's own position, and leftover dust goes to the OWNER.
        * _settleNet was DELETED. The contract holds no inventory and spends none, so the shared
          unattributed pot that the keeper drained cannot exist.
        * whitelistPool is now a FAIL-CLOSED ALLOWLIST on hook IDENTITY: it admits a pool IFF its hook
          equals the immutable `moleHook` pin (address(0) in these tests, the pre-MoleHook interim
          pin passed as the 6th constructor arg), and refuses every other hook deny-by-default with
          HookNotPermitted, before it ever inspects which bits the hook carries. It also still
          requires tickSpacing>0. This replaced an earlier fail-OPEN filter that admitted any hook
          lacking the remove-liquidity bits — the same fail-open shape and the same
          deposit-path-validator-with-a-carve-out that cost Gamma $6.18M.
        * open() takes amount0Max / amount1Max / deadline.

    CONSEQUENCE FOR TESTS: a position's liquidity NUMBER is no longer invariant across a rebalance.
    Narrowing buys more liquidity with the same tokens, widening buys less, and a same-range
    rebalance buys MORE because the fees are folded in. Every test below that assumed a constant L
    encoded the old, wrong semantics and has been rewritten to withdraw the CURRENT liquidity.

    Tests renamed test_attack_* -> test_regression_* are exploits that are confirmed dead: the whole
    attack is still attempted, only the expected outcome changed. Each pins the specific property
    that killed it, in preference to a revert string, so it survives refactoring.

    ---------------------------------------------------------------------------------------------
    FIXED  Hostile hook skimming a cut off every withdrawal.
                 whitelistPool is a fail-closed allowlist on hook identity: a pool is admissible IFF
                 its hook equals `moleHook` (address(0) here), so the ExitTaxHook — a foreign hook —
                 cannot be registered at all, whether it sits at an address carrying the whole
                 WITHDRAWAL_PATH_MASK (0x0301) or at one the OLD bit-filter would have waved through.
                 With no listing there is no position, so the tax is unreachable: fully armed, the
                 attacker collects exactly 0.
                 -> test_regression_exitTaxHookIsRejectedAndUnreachable
                 -> testFuzz_regression_exitTaxHookTakesZeroForEveryTaxAmount
                 -> testFuzz_regression_whitelistAcceptsExactlyTheMoleHookAndRejectsEveryForeignHook

    FIXED  Hostile hook freezing withdrawals permanently.
                 Same gate. Any non-zero hook is unlistable while moleHook == address(0), so no
                 position can ever be opened behind a hook that wants to block exits — the freezing
                 hook is refused at admission with HookNotPermitted and never called.
                 -> test_regression_whitelistRejectsEveryRemovePathBitCombination
                 -> test_regression_exitFreezingHookCannotEvenBeListed

    FIXED  rebalance() confiscating the owner's accrued fees into an unowned contract balance.
                 The contract's token balance is now exactly zero at every point of the sequence,
                 and a same-range rebalance INCREASES position liquidity because the fees that used
                 to be swept are re-minted into the owner's own position.
                 -> test_regression_rebalanceCompoundsFeesAndLeavesNothingInTheContract

    FIXED  A compromised keeper turning that pot into cash in an attacker's wallet.
                 With no inventory to spend, a widening rebalance is funded only by the burn it
                 just performed. The attacker runs the identical sequence and ends POORER.
                 -> test_regression_keeperCannotMoveValueBetweenPositions

    FIXED  rebalance() reverting on a contract with no balance.
                 It was only ever "not self-funding" because it held L constant. Deriving L from the
                 amounts makes it self-funding by construction, on a zero-balance contract.
                 -> test_regression_wideningRebalanceIsSelfFundingWithZeroContractBalance

    FIXED  whitelistPool accepting tickSpacing == 0 and panicking later on `tick % 0`.
                 -> test_regression_zeroTickSpacingIsRejectedAtWhitelist

    FIXED AT ADMISSION  (was STILL LIVE, PARTIALLY MITIGATED)
                 Hostile hook overcharging the opener. 0x0C02 (BEFORE_ADD | AFTER_ADD |
                 AFTER_ADD_RETURNS_DELTA) carries no withdrawal-path bit, so under the OLD fail-open
                 filter it passed the gate and drained an uncapped opener's whole allowance (F-1).
                 Under the fail-closed allowlist it is a foreign hook (moleHook == address(0)) and
                 cannot be listed at all, so the drain is unreachable: whitelistPool reverts
                 HookNotPermitted and the opener's balance/allowance never move. The amount0Max /
                 amount1Max cap added in the 2026-08-02 fix is still a real, opt-in defence and is
                 exercised on the admissible hookless pool, where an over-tight ceiling reverts
                 ExceedsMaxAmount before a token moves.
                 -> test_regression_hostileHookDrainCannotBeListedAndTheCapStillGuardsTheOpener

    STILL LIVE, PARTIALLY MITIGATED
                 Sequencer ordering still decides which basket a user buys; amount0Max/amount1Max
                 turn that from a silent loss into a revert, for callers who set them.
                 -> test_attack_openHasNoAmountBoundSoOrderingChangesTheBill

    DESIGN-COST  A blacklisted owner is stranded forever. take() hardcodes positions[id].owner and
                 there is no `to` parameter, no owner transfer and no rescue, so a USDC-style
                 blacklist (or any token that reverts transfers to that address) locks the position
                 permanently. The only "successful" exit is a dust withdraw that burns liquidity for
                 zero tokens. This is the real, stated price of the hardcoded recipient: the
                 property that makes theft impossible also makes recovery impossible.
                 -> test_attack_blacklistedOwnerIsPermanentlyStranded

    DESIGN-COST  A token whose balance can shrink after settle (rebase / admin burn) bricks exits for
                 every position in that pool. Contained to the hostile currency, but permanent.
                 -> test_attack_rebasingTokenBricksExitsForThatPool

    DESIGN-COST  A whitelisted pool with tickSpacing > maxRangeWidth is dead on arrival: every legal
                 range is wider than the immutable ceiling. Permissionless whitelisting means such
                 pools can be advertised freely.
                 -> test_attack_tickSpacingAboveMaxRangeWidthMakesPoolUnusable

    MITIGATED    whitelistPool cannot re-point an existing PoolId: PoolId is keccak of the whole
                 key, so a different key is a different id, and re-registering reverts.
                 -> test_attack_whitelistCannotRepointAnExistingPoolId

    MITIGATED    Fee-on-transfer token: settle() credits only what arrived, the unlock ends with a
                 non-zero delta and the whole open() unwinds. No id consumed, no owner-index
                 pollution, nothing stranded in the PoolManager.
                 -> test_attack_feeOnTransferTokenCannotOpen

    MITIGATED    Reentrancy from an ERC-777 style token running between sync() and settle(): open()
                 hits AlreadyUnlocked (v4's global lock), withdraw() hits NotOwner, and a direct
                 unlockCallback() hits NotPoolManager. Reentrancy from a hook running inside
                 PoolManager.modifyLiquidity — the strongest frame an attacker can reach — is now
                 closed one layer earlier: the hook pool cannot be whitelisted (moleHook ==
                 address(0)), so the hook is never called inside a mole unlock and that frame does
                 not exist to reenter from. The armed hook is refused at admission with
                 HookNotPermitted and never fires.
                 -> test_attack_hostileHookCannotReenterMolePositions
                 -> test_attack_reentrantTokenCannotReenterDuringSettle

    MITIGATED    A token that hijacks the settle() credit (by calling PoolManager.settle() itself
                 mid-transfer) or re-syncs a different currency does succeed in misdirecting the
                 credit - and the position's debt then goes unsettled, so the transaction reverts.
                 Fails closed, but note the "no external call between sync and settle" comment in
                 _settleFrom is not true: the transfer itself is the external call.
                 -> test_attack_reentrantTokenHijackingSettleCreditFailsClosed
                 -> test_attack_reentrantTokenResyncingOtherCurrencyFailsClosed

    MITIGATED    A token that inflates the PoolManager's apparent balance to over-credit settle()
                 cannot monetise it: MolePositions never takes a positive residue on the open path,
                 so the unlock ends non-zero and reverts.
                 -> test_attack_overCreditingTokenCannotMintCredit

    MITIGATED    Tick edges: equal, inverted, off-spacing, and out-of-domain ticks all revert with
                 the specific named error, and MIN_TICK/MAX_TICK are rejected on spacing first.
                 -> test_attack_tickEdgeCasesAllRevertCleanly

    NOT-REACHABLE  Decimals. MolePositions performs no unit conversion anywhere, so 0-decimal and
                 24-decimal tokens behave exactly as 18-decimal ones.
                 -> test_attack_extremeDecimalsChangeNothing

    ---------------------------------------------------------------------------------------------
    ENVIRONMENT NOTE. This file was written when foundry.toml said optimizer_runs = 800, at which
    solc 0.8.26 + via_ir cannot compile v4-core's PoolManager at all (Yul "stack too deep" inside
    Pool.swap). It therefore does not import PoolManager: the canonical creation code from
    lib/v4-core/src/PoolManager.sol is embedded at the bottom and deployed with CREATE in setUp().
    foundry.toml now says 44444444 and does compile PoolManager, so the blob is no longer forced -
    it is kept because it pins the exact PoolManager bytecode these findings were measured against,
    which is the whole point of a regression suite. Everything else (PoolModifyLiquidityTest,
    PoolSwapTest, MockERC20) is imported normally from v4-core.

//////////////////////////////////////////////////////////////////////////////*/

// `stdError` is gone with the Panic(0x12) it used to expect: whitelistPool now rejects tickSpacing 0
// before any caller can reach `tick % 0`. See test_regression_zeroTickSpacingIsRejectedAtWhitelist.
import {Test, console2} from "forge-std/Test.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";

import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {IERC20Minimal} from "v4-core/interfaces/external/IERC20Minimal.sol";
import {Hooks} from "v4-core/libraries/Hooks.sol";
import {CustomRevert} from "v4-core/libraries/CustomRevert.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/types/PoolId.sol";
import {Currency, CurrencyLibrary} from "v4-core/types/Currency.sol";
import {BalanceDelta, toBalanceDelta} from "v4-core/types/BalanceDelta.sol";
import {ModifyLiquidityParams, SwapParams} from "v4-core/types/PoolOperation.sol";
import {TickMath} from "v4-core/libraries/TickMath.sol";
import {PoolModifyLiquidityTest} from "v4-core/test/PoolModifyLiquidityTest.sol";
import {PoolSwapTest} from "v4-core/test/PoolSwapTest.sol";

import {MolePositions} from "../../src/MolePositions.sol";
import {HookPermissions} from "../../src/config/HookPermissions.sol";
import {deployMoleVault, deployMoleVaultOwned, hookProxyArgs, deployMoleHookAnywhere, TEST_UPGRADE_ADMIN} from "../helpers/ProxyDeploy.sol";

/*//////////////////////////////////////////////////////////////////////////////
                              HOSTILE TOKEN ZOO
//////////////////////////////////////////////////////////////////////////////*/

contract BasicERC20 {
    string public name;
    string public symbol;
    uint8 public decimals;
    uint256 public totalSupply;
    mapping(address => uint256) internal _bal;
    mapping(address => mapping(address => uint256)) public allowance;

    constructor(string memory n, string memory s, uint8 d) {
        name = n;
        symbol = s;
        decimals = d;
    }

    function balanceOf(address who) public view virtual returns (uint256) {
        return _bal[who];
    }

    function mint(address to, uint256 a) public virtual {
        _bal[to] += a;
        totalSupply += a;
    }

    function approve(address sp, uint256 a) public virtual returns (bool) {
        allowance[msg.sender][sp] = a;
        return true;
    }

    function transfer(address to, uint256 a) public virtual returns (bool) {
        _xfer(msg.sender, to, a);
        return true;
    }

    function transferFrom(address f, address t, uint256 a) public virtual returns (bool) {
        uint256 al = allowance[f][msg.sender];
        if (al != type(uint256).max) allowance[f][msg.sender] = al - a;
        _xfer(f, t, a);
        return true;
    }

    function _xfer(address f, address t, uint256 a) internal virtual {
        _bal[f] -= a;
        _bal[t] += a;
    }
}

/// @notice 2% burned on every move: the PoolManager always receives less than `amount`.
contract FeeOnTransferToken is BasicERC20 {
    constructor() BasicERC20("FOT", "FOT", 18) {}

    function _xfer(address f, address t, uint256 a) internal override {
        uint256 fee = a * 200 / 10_000;
        _bal[f] -= a;
        _bal[t] += (a - fee);
        totalSupply -= fee;
    }
}

/// @notice USDC-style blacklist: any transfer *to* a blocked address reverts.
contract BlacklistToken is BasicERC20 {
    mapping(address => bool) public blocked;

    constructor() BasicERC20("BL", "BL", 18) {}

    function blockAddress(address who) external {
        blocked[who] = true;
    }

    function _xfer(address f, address t, uint256 a) internal override {
        require(!blocked[t], "BLACKLISTED");
        _bal[f] -= a;
        _bal[t] += a;
    }
}

/// @notice Balance can shrink after settle (negative rebase / admin burn).
contract RebasingToken is BasicERC20 {
    constructor() BasicERC20("RB", "RB", 18) {}

    function shrink(address who, uint256 amount) external {
        _bal[who] -= amount;
        totalSupply -= amount;
    }
}

/// @notice Lies about the PoolManager's balance so that settle() credits more than was paid — the
///         canonical way to mint a delta out of nothing in v4.
contract OverCreditToken is BasicERC20 {
    address public pm;
    uint256 public phantom;

    constructor() BasicERC20("OC", "OC", 18) {}

    function setPoolManager(address p) external {
        pm = p;
    }

    function balanceOf(address who) public view override returns (uint256) {
        return who == pm ? _bal[who] + phantom : _bal[who];
    }

    function _xfer(address f, address t, uint256 a) internal override {
        _bal[f] -= a;
        _bal[t] += a;
        if (t == pm) phantom += a; // after the transfer, the PM appears to hold 2x what arrived
    }
}

/// @notice ERC-777 style: calls an arbitrary target in the middle of every transfer, i.e. exactly
///         between MolePositions' `sync()` and its `settle()`.
contract ReentrantToken is BasicERC20 {
    address public target;
    bytes public payload;
    bool public armed;
    bool public fired;
    bool public innerOk;
    bytes public innerReturn;

    constructor() BasicERC20("RE", "RE", 18) {}

    function arm(address t, bytes memory p) external {
        target = t;
        payload = p;
        armed = true;
        fired = false;
    }

    function _xfer(address f, address t, uint256 a) internal override {
        _bal[f] -= a;
        _bal[t] += a;
        if (armed && !fired) {
            fired = true;
            (bool ok, bytes memory ret) = target.call(payload);
            innerOk = ok;
            innerReturn = ret;
        }
    }
}

/*//////////////////////////////////////////////////////////////////////////////
                                 HOSTILE HOOKS
//////////////////////////////////////////////////////////////////////////////*/

/// @dev Reverts every remove-liquidity call once armed. Deployed in the regression tests at an address
///      carrying `BEFORE_REMOVE_LIQUIDITY_FLAG` (0x0200), and also at an address carrying only a
///      harmless off-path bit. Under the current fail-closed identity allowlist BOTH are foreign hooks
///      (neither equals moleHook == address(0)), so whitelistPool refuses both with HookNotPermitted —
///      the hook is left fully armed as the thing being refused, and never gets the chance to fire.
contract RemoveBlockingHook {
    bool public blocking;

    function setBlocking(bool b) external {
        blocking = b;
    }

    function beforeRemoveLiquidity(address, PoolKey calldata, ModifyLiquidityParams calldata, bytes calldata)
        external
        view
        returns (bytes4)
    {
        require(!blocking, "HOOK: exits disabled");
        return IHooks.beforeRemoveLiquidity.selector;
    }
}

/// @dev beforeRemoveLiquidity takes the tax (hook delta -tax), afterRemoveLiquidity returns +tax so
///      the hook's own delta nets to zero and the shortfall lands entirely on the exiting owner.
///      Deployed in the regression tests at an address carrying EXACTLY
///      `HookPermissions.WITHDRAWAL_PATH_MASK` (0x0301) — the three bits the project documents as
///      "must be zero in the mined address, forever" — and also at an address off the withdrawal path
///      that the OLD bit-filter accepted. Under the current fail-closed identity allowlist both are
///      foreign hooks (neither equals moleHook == address(0)), so whitelistPool refuses both with
///      HookNotPermitted while the tax is fully armed: the skim is unreachable, never collected.
contract ExitTaxHook {
    IPoolManager public pm;
    address public loot;
    uint128 public tax;

    function setup(IPoolManager _pm, address _loot, uint128 _tax) external {
        pm = _pm;
        loot = _loot;
        tax = _tax;
    }

    function beforeRemoveLiquidity(address, PoolKey calldata key, ModifyLiquidityParams calldata, bytes calldata)
        external
        returns (bytes4)
    {
        if (tax > 0) pm.take(key.currency0, loot, tax);
        return IHooks.beforeRemoveLiquidity.selector;
    }

    function afterRemoveLiquidity(
        address,
        PoolKey calldata,
        ModifyLiquidityParams calldata,
        BalanceDelta,
        BalanceDelta,
        bytes calldata
    ) external view returns (bytes4, BalanceDelta) {
        return (IHooks.afterRemoveLiquidity.selector, toBalanceDelta(int128(tax), 0));
    }
}

/// @dev Carries BEFORE_ADD_LIQUIDITY | AFTER_ADD_LIQUIDITY | AFTER_ADD_LIQUIDITY_RETURNS_DELTA
///      (0x0C02). Inflates what the opener owes on the deposit path — the original F-1 drain. It
///      carries no withdrawal-path bit, so the OLD fail-open filter admitted it; the current
///      fail-closed identity allowlist refuses it (it is not moleHook == address(0)), so it can never
///      be listed and the drain is unreachable. Kept fully armed as the thing being refused.
contract AllowanceDrainingHook {
    IPoolManager public pm;
    address public loot;
    uint128 public charge;

    function setup(IPoolManager _pm, address _loot, uint128 _charge) external {
        pm = _pm;
        loot = _loot;
        charge = _charge;
    }

    function beforeAddLiquidity(address, PoolKey calldata key, ModifyLiquidityParams calldata, bytes calldata)
        external
        returns (bytes4)
    {
        if (charge > 0) pm.take(key.currency0, loot, charge);
        return IHooks.beforeAddLiquidity.selector;
    }

    function afterAddLiquidity(
        address,
        PoolKey calldata,
        ModifyLiquidityParams calldata,
        BalanceDelta,
        BalanceDelta,
        bytes calldata
    ) external view returns (bytes4, BalanceDelta) {
        return (IHooks.afterAddLiquidity.selector, toBalanceDelta(int128(charge), 0));
    }
}

/// @dev Carries ONLY `BEFORE_ADD_LIQUIDITY_FLAG` (0x0800). Designed to run INSIDE
///      PoolManager.modifyLiquidity, i.e. inside MolePositions' own unlock — the strongest frame an
///      attacker can reach — and reenter from there. Under the current fail-closed identity allowlist
///      it is a foreign hook (not moleHook == address(0)), so its pool can never be whitelisted: the
///      hook is never called inside a mole unlock, so that frame does not exist to reenter from. Kept
///      fully armed as the thing being refused; `fired` stays false because it never runs.
contract ReenteringHook {
    address public target;
    bytes public payload;
    bool public armed;
    bool public fired;
    bool public innerOk;
    bytes public innerReturn;

    function arm(address t, bytes memory p) external {
        target = t;
        payload = p;
        armed = true;
        fired = false;
    }

    function beforeAddLiquidity(address, PoolKey calldata, ModifyLiquidityParams calldata, bytes calldata)
        external
        returns (bytes4)
    {
        if (armed && !fired) {
            fired = true;
            (bool ok, bytes memory ret) = target.call(payload);
            innerOk = ok;
            innerReturn = ret;
        }
        return IHooks.beforeAddLiquidity.selector;
    }
}

/*//////////////////////////////////////////////////////////////////////////////
                                    TESTS
//////////////////////////////////////////////////////////////////////////////*/

contract AttackPoolAndTokensTest is Test {
    using PoolIdLibrary for PoolKey;

    IPoolManager internal manager;
    PoolModifyLiquidityTest internal lpRouter;
    PoolSwapTest internal swapRouter;
    MolePositions internal mole;

    address internal keeper = makeAddr("keeper");
    address internal alice = makeAddr("alice"); // honest LP
    address internal mallory = makeAddr("mallory"); // attacker

    uint160 internal constant SQRT_PRICE_1_1 = 79228162514264337593543950336;
    uint160 internal constant MIN_PRICE_LIMIT = TickMath.MIN_SQRT_PRICE + 1;
    uint160 internal constant MAX_PRICE_LIMIT = TickMath.MAX_SQRT_PRICE - 1;
    bytes internal constant NO_HOOK_DATA = "";

    uint32 internal constant MIN_INTERVAL = 1 hours;
    int24 internal constant MIN_WIDTH = 60;
    int24 internal constant MAX_WIDTH = 200_000;

    /// @dev A permission bit off the withdrawal path: beforeDonate (0x0020) carries none of
    ///      HookPermissions.WITHDRAWAL_PATH_MASK, and it is non-zero (which v4 requires of any hook
    ///      address). Under the OLD fail-open bit-filter a hook at such an address WAS admissible —
    ///      "absence of power over the withdrawal path". Under the current fail-closed identity
    ///      allowlist it is NOT: it is a foreign hook (it does not equal moleHook == address(0)), so
    ///      whitelistPool refuses it with HookNotPermitted. The tests below deploy hostile hooks at
    ///      these addresses precisely to prove admission now denies even the plausible-looking ones
    ///      the old model would have waved through.
    uint160 internal constant EXIT_SAFE_FLAG = uint160(Hooks.BEFORE_DONATE_FLAG);

    MockERC20 internal t0;
    MockERC20 internal t1;
    Currency internal c0;
    Currency internal c1;
    PoolKey internal plainKey;

    /*------------------------------------------------------------------ setup */

    /// @dev Explicit accumulating clock. Absolute `vm.warp(1_000_000)` moved time FORWARD locally (where
    ///      block.timestamp starts near 1) but BACKWARD on a fork of a live chain (~1.79e9), which is why
    ///      three tests in this file failed only under --fork-url. Relative `vm.warp(block.timestamp + d)`
    ///      is not sufficient on its own either: block.timestamp cannot change inside a call frame, so
    ///      solc caches it and a second warp in the same test would not accumulate.
    uint256 internal _clock;

    function _warpBy(uint256 secs) internal {
        _clock += secs;
        vm.warp(_clock);
    }

    function setUp() public {
        _clock = block.timestamp;
        manager = _deployPoolManager(address(this));
        lpRouter = new PoolModifyLiquidityTest(manager);
        swapRouter = new PoolSwapTest(manager);

        MockERC20 x = new MockERC20("A", "A", 18);
        MockERC20 y = new MockERC20("B", "B", 18);
        (t0, t1) = address(x) < address(y) ? (x, y) : (y, x);
        c0 = Currency.wrap(address(t0));
        c1 = Currency.wrap(address(t1));

        mole = deployMoleVault(manager, keeper, MIN_INTERVAL, MIN_WIDTH, MAX_WIDTH, address(0), 0, 0, 0, 0, 10_000, 0, 0, address(0));

        plainKey = PoolKey(c0, c1, 3000, 60, IHooks(address(0)));
        manager.initialize(plainKey, SQRT_PRICE_1_1);
        mole.whitelistPool(plainKey);

        // Background depth + swap allowance for this test contract.
        t0.mint(address(this), 1e32);
        t1.mint(address(this), 1e32);
        t0.approve(address(lpRouter), type(uint256).max);
        t1.approve(address(lpRouter), type(uint256).max);
        t0.approve(address(swapRouter), type(uint256).max);
        t1.approve(address(swapRouter), type(uint256).max);
        lpRouter.modifyLiquidity(
            plainKey,
            ModifyLiquidityParams({tickLower: -60_000, tickUpper: 60_000, liquidityDelta: 1e21, salt: 0}),
            NO_HOOK_DATA
        );

        _fundMole(alice);
        _fundMole(mallory);
    }

    function _fundMole(address who) internal {
        t0.mint(who, 1e30);
        t1.mint(who, 1e30);
        vm.startPrank(who);
        t0.approve(address(mole), type(uint256).max);
        t1.approve(address(mole), type(uint256).max);
        vm.stopPrank();
    }

    /// @dev The repo's own foundry.toml (via_ir + optimizer_runs = 800) cannot compile v4-core's
    ///      PoolManager — solc aborts with a Yul "stack too deep" inside Pool.swap. Rather than edit
    ///      shared config, the canonical PoolManager creation code (v4-core @ lib/, solc 0.8.26,
    ///      cancun, via_ir, optimizer runs 200) is embedded at the bottom of this file and deployed
    ///      here. This is the real v4 PoolManager, byte-for-byte from lib/v4-core/src/PoolManager.sol.
    function _deployPoolManager(address owner_) internal returns (IPoolManager pm) {
        bytes memory init = bytes.concat(PoolManagerBytecode.CREATION, abi.encode(owner_));
        address a;
        assembly ("memory-safe") {
            a := create(0, add(init, 0x20), mload(init))
        }
        require(a != address(0), "PoolManager deploy failed");
        pm = IPoolManager(a);
    }

    function _sorted(address a, address b) internal pure returns (Currency lo, Currency hi) {
        return a < b ? (Currency.wrap(a), Currency.wrap(b)) : (Currency.wrap(b), Currency.wrap(a));
    }

    /// @dev A non-zero address off the withdrawal path — the shape the OLD bit-filter accepted but the
    ///      current identity allowlist refuses (it is not moleHook == address(0)). Used to deploy a
    ///      hostile hook at a plausible-looking address and prove whitelistPool denies it anyway.
    function _exitSafeHookAddr(uint160 salt) internal pure returns (address a) {
        a = address((salt << 144) | EXIT_SAFE_FLAG);
        require(HookPermissions.withdrawalIsUnblockable(a), "test bug: helper produced a remove-bit hook");
    }

    /// @dev Every token this contract could possibly be holding. The single most load-bearing
    ///      assertion in this file: the deleted `_settleNet` is exactly the function that made this
    ///      number non-zero, and a non-zero number here is the shared, unowned pot a compromised
    ///      keeper drained. It must be zero before, during and after every sequence.
    function _assertMoleHoldsNothing(string memory when) internal view {
        assertEq(t0.balanceOf(address(mole)), 0, string.concat("contract holds c0 ", when));
        assertEq(t1.balanceOf(address(mole)), 0, string.concat("contract holds c1 ", when));
    }

    function _swapExactIn(PoolKey memory k, bool zeroForOne, int256 amountIn) internal {
        swapRouter.swap(
            k,
            SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: -amountIn,
                sqrtPriceLimitX96: zeroForOne ? MIN_PRICE_LIMIT : MAX_PRICE_LIMIT
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            NO_HOOK_DATA
        );
    }

    /*------------------------------------------------------- control / sanity */

    /// @notice Control case. Everything below is measured against this working round trip.
    function test_control_openWithdrawRoundTrip() public {
        uint256 before0 = t0.balanceOf(alice);
        uint256 before1 = t1.balanceOf(alice);

        vm.prank(alice);
        uint256 id = mole.open(plainKey, -600, 600, 1e18, type(uint256).max, type(uint256).max, block.timestamp);
        assertEq(mole.ownerOf(id), alice, "owner must be msg.sender");

        vm.prank(alice);
        mole.withdraw(id, 1e18);

        assertEq(mole.getPosition(id).liquidity, 0, "position not closed");
        // v4 rounds in the pool's favour on both legs, so a round trip is lossy by dust only.
        assertLe(before0 - t0.balanceOf(alice), 3, "unexpected c0 loss");
        assertLe(before1 - t1.balanceOf(alice), 3, "unexpected c1 loss");
        assertEq(t0.balanceOf(address(mole)), 0, "contract retained c0");
        assertEq(t1.balanceOf(address(mole)), 0, "contract retained c1");
    }

    /*==========================================================================
                        1. PERMISSIONLESS WHITELIST: HOSTILE HOOKS
    ==========================================================================*/

    /// @notice REGRESSION (was test_attack_whitelistedHookWithRemoveBitCanFreezeWithdrawalsForever).
    ///         Used to prove: anyone could whitelist a pool whose hook carries BEFORE_REMOVE_LIQUIDITY
    ///         and that hook could then freeze every exit forever. Now pins: under the fail-closed
    ///         identity allowlist a remove-bit hook is a foreign hook (it is not moleHook ==
    ///         address(0)), so whitelistPool refuses it with HookNotPermitted BEFORE it inspects a
    ///         single bit, and the position that would be frozen can never be opened. The remove bit
    ///         is still asserted present via the project's own predicate — the hook really is hostile —
    ///         it is simply denied by default now rather than by a bit carve-out. The blocking hook is
    ///         still deployed and still armed.
    function test_regression_whitelistRejectsEveryRemovePathBitCombination() public {
        address hookAddr = address(uint160(0x4444 << 144) | uint160(Hooks.BEFORE_REMOVE_LIQUIDITY_FLAG));
        deployCodeTo("AttackPoolAndTokens.t.sol:RemoveBlockingHook", hookAddr);
        RemoveBlockingHook hook = RemoveBlockingHook(hookAddr);
        hook.setBlocking(true); // armed from the start: it never gets the chance to fire

        // The project's own predicate confirms this hook really is on the withdrawal path...
        assertFalse(HookPermissions.withdrawalIsUnblockable(hookAddr), "hook should carry the remove bit");
        assertFalse(HookPermissions.isValid(hookAddr), "hook should fail the project's own bitmap check");

        PoolKey memory k = PoolKey(c0, c1, 3000, 60, IHooks(hookAddr));
        manager.initialize(k, SQRT_PRICE_1_1); // the POOL is fine; it is the custody listing that is not

        // ...and MolePositions refuses it deny-by-default (it is not the moleHook pin), no matter who asks.
        vm.prank(mallory);
        vm.expectRevert(MolePositions.HookNotPermitted.selector);
        mole.whitelistPool(k);
        assertFalse(mole.isWhitelisted(k.toId()), "hostile pool must not be whitelisted");

        // With no listing there is no position, so there is nothing to freeze.
        vm.prank(alice);
        vm.expectRevert(MolePositions.PoolNotWhitelisted.selector);
        mole.open(k, -600, 600, 1e18, type(uint256).max, type(uint256).max, block.timestamp);

        // The identity gate refuses a foreign hook a fortiori, so all seven non-empty combinations of
        // the three remove-path bits are refused — each is a non-zero, non-moleHook address.
        uint160[3] memory bits = [
            uint160(Hooks.BEFORE_REMOVE_LIQUIDITY_FLAG),
            uint160(Hooks.AFTER_REMOVE_LIQUIDITY_FLAG),
            uint160(Hooks.AFTER_REMOVE_LIQUIDITY_RETURNS_DELTA_FLAG)
        ];
        for (uint256 combo = 1; combo < 8; ++combo) {
            uint160 flags;
            for (uint256 b; b < 3; ++b) {
                if (combo & (1 << b) != 0) flags |= bits[b];
            }
            address a = address((uint160(0x4100 + combo) << 144) | flags);
            assertFalse(HookPermissions.withdrawalIsUnblockable(a), "combo should be unsafe");

            PoolKey memory kk = PoolKey(c0, c1, 3000, 60, IHooks(a));
            vm.prank(mallory);
            vm.expectRevert(MolePositions.HookNotPermitted.selector);
            mole.whitelistPool(kk);
            assertFalse(mole.isWhitelisted(kk.toId()), "remove-path hook slipped through");
        }

        // The invariant a user can check from the address alone, with no trust in this contract.
        assertEq(
            uint160(address(mole.poolKeyOf(plainKey.toId()).hooks)) & HookPermissions.WITHDRAWAL_PATH_MASK,
            0,
            "every listed pool must be provably off the withdrawal path"
        );
    }

    /// @notice REGRESSION (was test_attack_keeperCannotRescueAPositionFrozenByAHostileHook, then
    ///         test_regression_acceptedHookCannotFreezeExitsEvenWhenItTries). The "accepted hook"
    ///         premise is now FALSE and this positive control is INVERTED, as intended by the
    ///         fail-closed redesign: an exit-freezing hook — even at an address off the withdrawal path
    ///         that the OLD bit-filter would have accepted — is a foreign hook (not moleHook ==
    ///         address(0)), so whitelistPool refuses it with HookNotPermitted. It can never be listed,
    ///         so no position can be opened behind it and its freezing is unreachable. The genuinely
    ///         hookless positive control the old test proved (open / keeper rebalance / full exit all
    ///         work) is preserved here on the admissible hookless pool, which is where that machinery
    ///         can actually run.
    function test_regression_exitFreezingHookCannotEvenBeListed() public {
        address hookAddr = _exitSafeHookAddr(0x4445);
        deployCodeTo("AttackPoolAndTokens.t.sol:RemoveBlockingHook", hookAddr);
        RemoveBlockingHook hook = RemoveBlockingHook(hookAddr);
        hook.setBlocking(true); // fully armed to freeze every exit — it will never get the chance

        PoolKey memory k = PoolKey(c0, c1, 3000, 60, IHooks(hookAddr));
        manager.initialize(k, SQRT_PRICE_1_1);

        // Refused deny-by-default: a foreign hook is not the moleHook pin, no matter who asks.
        vm.prank(mallory);
        vm.expectRevert(MolePositions.HookNotPermitted.selector);
        mole.whitelistPool(k);
        assertFalse(mole.isWhitelisted(k.toId()), "exit-freezing hook pool must not be whitelisted");
        assertTrue(hook.blocking(), "hook must still be armed - otherwise this proves nothing");

        // With no listing there is no position, so the armed hook has nothing to freeze.
        vm.prank(alice);
        vm.expectRevert(MolePositions.PoolNotWhitelisted.selector);
        mole.open(k, -600, 600, 1e18, type(uint256).max, type(uint256).max, block.timestamp);

        // POSITIVE CONTROL preserved on the genuinely hookless pool: the keeper's lever works and the
        // owner's exit works, for the whole position, with nothing stranded. This is the machinery the
        // old test ran behind an "accepted" hook; it now runs where a pool is actually admissible.
        vm.prank(alice);
        uint256 id = mole.open(plainKey, -600, 600, 1e18, type(uint256).max, type(uint256).max, block.timestamp);

        _warpBy(MIN_INTERVAL + 1);
        vm.prank(keeper);
        mole.rebalance(id, -540, 660);

        uint128 live = mole.getPosition(id).liquidity;
        assertGt(live, 0, "rebalance destroyed the position");
        uint256 before0 = t0.balanceOf(alice);
        uint256 before1 = t1.balanceOf(alice);
        vm.prank(alice);
        mole.withdraw(id, live);

        assertEq(mole.getPosition(id).liquidity, 0, "position should be fully closed");
        assertGt(t0.balanceOf(alice) - before0, 0, "exit paid no c0");
        assertGt(t1.balanceOf(alice) - before1, 0, "exit paid no c1");
        _assertMoleHoldsNothing("after a hookless open / rebalance / full exit");
    }

    /// @notice REGRESSION (was test_attack_hostileHookTaxesEveryWithdrawalAndPaysTheAttacker).
    ///         Used to prove: a hook carrying exactly HookPermissions.WITHDRAWAL_PATH_MASK skimmed
    ///         91% of an exit and paid it to the attacker. Now pins that the taxing hook is REJECTED
    ///         at admission and therefore UNREACHABLE, at BOTH the mask-carrying address the original
    ///         attack used AND the off-withdrawal-path address the OLD bit-filter would have accepted:
    ///         under the fail-closed identity allowlist each is a foreign hook (not moleHook ==
    ///         address(0)) and whitelistPool refuses it with HookNotPermitted, so no position can be
    ///         opened behind it and the armed tax collects exactly zero. The lossless hookless control
    ///         in the middle is the value an exit is worth when no foreign hook can sit on the path.
    function test_regression_exitTaxHookIsRejectedAndUnreachable() public {
        // (a) the address the original attack used, carrying exactly WITHDRAWAL_PATH_MASK.
        address hookAddr = address(uint160(0x7777 << 144) | uint160(HookPermissions.WITHDRAWAL_PATH_MASK));
        deployCodeTo("AttackPoolAndTokens.t.sol:ExitTaxHook", hookAddr);
        ExitTaxHook hook = ExitTaxHook(hookAddr);
        assertEq(uint160(hookAddr) & HookPermissions.WITHDRAWAL_PATH_MASK, HookPermissions.WITHDRAWAL_PATH_MASK);

        PoolKey memory k = PoolKey(c0, c1, 3000, 60, IHooks(hookAddr));
        manager.initialize(k, SQRT_PRICE_1_1);
        hook.setup(manager, mallory, 2.7e16); // armed before anyone even tries to list it

        vm.prank(mallory);
        vm.expectRevert(MolePositions.HookNotPermitted.selector);
        mole.whitelistPool(k); // refused deny-by-default: it is not the moleHook pin
        assertFalse(mole.isWhitelisted(k.toId()), "taxing pool must not be listed");
        assertEq(hook.tax(), uint128(2.7e16), "hook must still be armed - otherwise this proves nothing");

        // Control: the round trip in the hookless pool is lossless bar dust. This is the number the
        // tax used to destroy — and it dwarfs the 2.7e16 tax the two hostile pools cannot charge.
        uint256 ref0 = t0.balanceOf(alice);
        vm.prank(alice);
        uint256 refId = mole.open(plainKey, -600, 600, 1e18, type(uint256).max, type(uint256).max, block.timestamp);
        vm.prank(alice);
        mole.withdraw(refId, 1e18);
        uint256 refNet0 = ref0 - t0.balanceOf(alice);
        assertLe(refNet0, 3, "control round trip should be lossless");

        // (b) the identical hook, identical tax, at the off-withdrawal-path address the OLD bit-filter
        // accepted. Under the fail-closed allowlist it is still a foreign hook, so it is refused too and
        // the tax is unreachable: there is no listed pool, no open, no exit for the skim to run through.
        address safeAddr = _exitSafeHookAddr(0x7777);
        deployCodeTo("AttackPoolAndTokens.t.sol:ExitTaxHook", safeAddr);
        ExitTaxHook safeHook = ExitTaxHook(safeAddr);
        safeHook.setup(manager, mallory, 2.7e16); // fully armed

        PoolKey memory sk = PoolKey(c0, c1, 3000, 60, IHooks(safeAddr));
        manager.initialize(sk, SQRT_PRICE_1_1);
        vm.prank(mallory);
        vm.expectRevert(MolePositions.HookNotPermitted.selector);
        mole.whitelistPool(sk);
        assertFalse(mole.isWhitelisted(sk.toId()), "off-path taxing pool must not be listed either");
        assertEq(safeHook.tax(), uint128(2.7e16), "off-path hook must still be armed - otherwise this proves nothing");

        uint256 lootBefore = t0.balanceOf(mallory);
        vm.prank(alice);
        vm.expectRevert(MolePositions.PoolNotWhitelisted.selector);
        mole.open(sk, -600, 600, 1e18, type(uint256).max, type(uint256).max, block.timestamp);
        assertEq(t0.balanceOf(mallory) - lootBefore, 0, "an unreachable exit tax collected something");
        _assertMoleHoldsNothing("after both taxing pools were refused admission");
    }

    /// @notice REGRESSION (was test_attack_hostileHookDrainsTheOpenersAllowance — an F-1 drain the old
    ///         fail-open filter left LIVE). The draining hook needs 0x0C02 (BEFORE_ADD | AFTER_ADD |
    ///         AFTER_ADD_RETURNS_DELTA), which carries no withdrawal-path bit, so the OLD filter
    ///         admitted it and it drained an uncapped opener's whole allowance on open(). Under the
    ///         fail-closed identity allowlist it is a foreign hook (not moleHook == address(0)) and
    ///         cannot be listed at all, so the drain is UNREACHABLE: whitelistPool reverts
    ///         HookNotPermitted and the opener's balance never moves. The amount0Max / amount1Max cap
    ///         the original test pinned is preserved here, exercised on the admissible hookless pool —
    ///         an over-tight ceiling reverts ExceedsMaxAmount before a token moves.
    function test_regression_hostileHookDrainCannotBeListedAndTheCapStillGuardsTheOpener() public {
        address hookAddr = address(uint160(0x8888 << 144) | uint160(0x0C02));
        deployCodeTo("AttackPoolAndTokens.t.sol:AllowanceDrainingHook", hookAddr);
        AllowanceDrainingHook hook = AllowanceDrainingHook(hookAddr);
        hook.setup(manager, mallory, 5e20); // fully armed to drain, before anyone tries to list it

        PoolKey memory k = PoolKey(c0, c1, 3000, 60, IHooks(hookAddr));
        manager.initialize(k, SQRT_PRICE_1_1);

        // The pool carrying the draining hook is refused deny-by-default, no matter who asks.
        uint256 aliceBefore = t0.balanceOf(alice);
        uint256 lootBefore = t0.balanceOf(mallory);
        vm.prank(mallory);
        vm.expectRevert(MolePositions.HookNotPermitted.selector);
        mole.whitelistPool(k);
        assertFalse(mole.isWhitelisted(k.toId()), "draining pool must not be listed");
        assertEq(hook.charge(), uint128(5e20), "hook must still be armed - otherwise this proves nothing");

        // With no listing, open() cannot reach the hook, so the drain is unreachable.
        vm.prank(alice);
        vm.expectRevert(MolePositions.PoolNotWhitelisted.selector);
        mole.open(k, -600, 600, 1e18, type(uint256).max, type(uint256).max, block.timestamp);
        assertEq(t0.balanceOf(alice), aliceBefore, "opener lost tokens to an unlistable hook");
        assertEq(t0.balanceOf(mallory), lootBefore, "attacker received a charge from an unlistable hook");
        assertEq(mole.positionCount(), 0, "a phantom position was created");

        // CAP DEFENCE, preserved on the admissible hookless pool. Learn the honest cost, then re-open
        // the byte-identical position with a ceiling BELOW that cost: open() refuses it with
        // ExceedsMaxAmount before a token moves. This is the amount0Max guard the original test pinned,
        // exercised where a position can actually be opened.
        uint256 fairBefore = t0.balanceOf(alice);
        vm.prank(alice);
        uint256 id = mole.open(plainKey, -600, 600, 1e18, type(uint256).max, type(uint256).max, block.timestamp);
        uint256 fairCost = fairBefore - t0.balanceOf(alice);
        console2.log("honest cost c0", fairCost);
        assertGt(fairCost, 1, "honest open must cost more than a wei for the cap to bite");
        assertEq(mole.getPosition(id).liquidity, 1e18, "honest open should have succeeded");

        uint256 cappedBefore0 = t0.balanceOf(alice);
        uint256 cappedBefore1 = t1.balanceOf(alice);
        vm.prank(alice);
        vm.expectRevert(MolePositions.ExceedsMaxAmount.selector);
        mole.open(plainKey, -600, 600, 1e18, fairCost - 1, type(uint256).max, block.timestamp);
        assertEq(t0.balanceOf(alice), cappedBefore0, "a capped open still cost the caller c0");
        assertEq(t1.balanceOf(alice), cappedBefore1, "a capped open still cost the caller c1");
        _assertMoleHoldsNothing("after the cap rejected an over-tight open");
    }

    /// @notice REGRESSION (was testFuzz_attack_exitTaxHookSkimsAnyChosenAmount).
    ///         Used to prove: the exit tax was not a knife-edge amount, the hook took any cut it
    ///         liked. Now pins that the cut is zero for EVERY cut it might choose because the taxing
    ///         pool is unlistable for every cut: under the fail-closed identity allowlist BOTH the
    ///         mask-carrying address the original attack used AND the off-withdrawal-path address the
    ///         OLD bit-filter would have accepted are foreign hooks (neither equals moleHook ==
    ///         address(0)), so each is refused with HookNotPermitted while fully armed with the fuzzed
    ///         tax. With no listing there is no position, so the skim is unreachable — zero, for any tax.
    function testFuzz_regression_exitTaxHookTakesZeroForEveryTaxAmount(uint128 tax) public {
        tax = uint128(bound(uint256(tax), 1, 2.9e16));

        // (a) the address the original attack used is refused, whatever the tax.
        address blockedAddr = address(uint160(0x7778 << 144) | uint160(HookPermissions.WITHDRAWAL_PATH_MASK));
        deployCodeTo("AttackPoolAndTokens.t.sol:ExitTaxHook", blockedAddr);
        ExitTaxHook(blockedAddr).setup(manager, mallory, tax);
        PoolKey memory blocked = PoolKey(c0, c1, 3000, 60, IHooks(blockedAddr));
        manager.initialize(blocked, SQRT_PRICE_1_1);
        vm.expectRevert(MolePositions.HookNotPermitted.selector);
        mole.whitelistPool(blocked);
        assertFalse(mole.isWhitelisted(blocked.toId()), "mask-carrying taxing pool was listed");

        // (b) the same hook at the address the OLD filter accepted is refused too, whatever the tax.
        address hookAddr = _exitSafeHookAddr(0x7778);
        deployCodeTo("AttackPoolAndTokens.t.sol:ExitTaxHook", hookAddr);
        ExitTaxHook hook = ExitTaxHook(hookAddr);
        hook.setup(manager, mallory, tax); // fully armed with the fuzzed cut

        PoolKey memory k = PoolKey(c0, c1, 3000, 60, IHooks(hookAddr));
        manager.initialize(k, SQRT_PRICE_1_1);
        vm.expectRevert(MolePositions.HookNotPermitted.selector);
        mole.whitelistPool(k);
        assertFalse(mole.isWhitelisted(k.toId()), "off-path taxing pool was listed");
        assertEq(hook.tax(), tax, "hook must still be armed with the fuzzed cut");

        // With neither pool listed the tax is unreachable: no open, no exit, no skim, for any tax.
        uint256 lootBefore = t0.balanceOf(mallory);
        vm.prank(alice);
        vm.expectRevert(MolePositions.PoolNotWhitelisted.selector);
        mole.open(k, -600, 600, 1e18, type(uint256).max, type(uint256).max, block.timestamp);
        assertEq(t0.balanceOf(mallory) - lootBefore, 0, "attacker got a cut with no listed pool");
        _assertMoleHoldsNothing("after a fuzzed exit tax was refused admission");
    }

    /// @notice REGRESSION (was testFuzz_attack_whitelistAcceptsEveryHookAddressIncludingUnsafeOnes,
    ///         then testFuzz_regression_whitelistAcceptsExactlyTheHooksOffTheWithdrawalPath). The
    ///         admission model changed from a fail-open bit-filter ("accept any hook lacking the
    ///         withdrawal-path bits", ~87.5% of the space) to a fail-closed allowlist on hook
    ///         IDENTITY ("accept only the pinned moleHook"). With moleHook == address(0) the ONLY
    ///         admissible hook is the hookless one, so this is INVERTED: the positive branch — a
    ///         foreign hook off the withdrawal path is accepted — is now the negative case, refused
    ///         with HookNotPermitted. That inversion is the intended, user-approved redesign. The
    ///         genuinely-hookless positive control is kept and asserted directly (not left to the
    ///         fuzzer, which would essentially never draw address(0)).
    function testFuzz_regression_whitelistAcceptsExactlyTheMoleHookAndRejectsEveryForeignHook(address hookAddr)
        public
    {
        // POSITIVE CONTROL, run every invocation: the pinned moleHook identity — here the hookless
        // pool — is admissible. A distinct fee keeps it off the pool setUp already listed.
        PoolKey memory admissible = PoolKey(c0, c1, 500, 60, IHooks(mole.moleHook()));
        vm.prank(mallory);
        mole.whitelistPool(admissible);
        assertTrue(mole.isWhitelisted(admissible.toId()), "the moleHook pool was rejected");
        assertEq(address(mole.poolKeyOf(admissible.toId()).hooks), mole.moleHook(), "listed hook is not the moleHook");
        // The pinned identity is off the withdrawal path by construction, restated from the stored key.
        assertEq(
            uint160(address(mole.poolKeyOf(admissible.toId()).hooks)) & HookPermissions.WITHDRAWAL_PATH_MASK,
            0,
            "listed hook sits on the withdrawal path"
        );

        // NEGATIVE PARTITION: every OTHER hook address — including ones the old fail-open filter would
        // have waved through (any address off WITHDRAWAL_PATH_MASK) — is refused with HookNotPermitted.
        vm.assume(hookAddr != mole.moleHook());
        PoolKey memory k = PoolKey(c0, c1, 3000, 60, IHooks(hookAddr));
        vm.assume(!mole.isWhitelisted(k.toId()));

        vm.prank(mallory);
        vm.expectRevert(MolePositions.HookNotPermitted.selector);
        mole.whitelistPool(k);
        assertFalse(mole.isWhitelisted(k.toId()), "a foreign hook was accepted");
        assertEq(address(mole.poolKeyOf(k.toId()).hooks), address(0), "rejected key was stored anyway");
    }

    /// @notice ATTACK: try to poison an already-whitelisted PoolId with a different PoolKey.
    ///         Defence holds — PoolId is the hash of the whole key, so the mapping cannot be
    ///         re-pointed, and re-registering the identical key reverts.
    function test_attack_whitelistCannotRepointAnExistingPoolId() public {
        PoolId id = plainKey.toId();
        PoolKey memory stored = mole.poolKeyOf(id);

        vm.prank(mallory);
        vm.expectRevert(MolePositions.PoolAlreadyWhitelisted.selector);
        mole.whitelistPool(plainKey);

        // Every single-field mutation yields a different PoolId, so nothing can alias.
        PoolKey memory m = plainKey;
        m.fee = 500;
        assertTrue(PoolId.unwrap(m.toId()) != PoolId.unwrap(id), "fee collision");
        m = plainKey;
        m.tickSpacing = 10;
        assertTrue(PoolId.unwrap(m.toId()) != PoolId.unwrap(id), "tickSpacing collision");
        m = plainKey;
        m.hooks = IHooks(address(0xdead));
        assertTrue(PoolId.unwrap(m.toId()) != PoolId.unwrap(id), "hooks collision");
        m = plainKey;
        m.currency1 = Currency.wrap(address(0xbeef));
        assertTrue(PoolId.unwrap(m.toId()) != PoolId.unwrap(id), "currency collision");

        PoolKey memory after_ = mole.poolKeyOf(id);
        assertEq(Currency.unwrap(after_.currency0), Currency.unwrap(stored.currency0));
        assertEq(after_.tickSpacing, stored.tickSpacing);
        assertEq(address(after_.hooks), address(stored.hooks));
    }

    /// @notice REGRESSION (was test_attack_whitelistedZeroTickSpacingPanicsInsteadOfReverting).
    ///         Used to prove: a PoolKey that can never be initialised (tickSpacing 0) was whitelisted
    ///         happily and open() then panicked with Panic(0x12) from `tick % 0`. Now pins that the
    ///         key is rejected at the gate, so no caller ever reaches the modulo — and that the
    ///         rejection is by a named error, not a panic.
    function test_regression_zeroTickSpacingIsRejectedAtWhitelist() public {
        PoolKey memory k = PoolKey(c0, c1, 3000, 0, IHooks(address(0)));
        vm.prank(mallory);
        vm.expectRevert(MolePositions.InvalidTickSpacing.selector);
        mole.whitelistPool(k);
        assertFalse(mole.isWhitelisted(k.toId()), "uninitialisable pool was listed");

        // Negative spacing is the same class of nonsense and is refused for the same reason.
        PoolKey memory neg = PoolKey(c0, c1, 3000, -60, IHooks(address(0)));
        vm.prank(mallory);
        vm.expectRevert(MolePositions.InvalidTickSpacing.selector);
        mole.whitelistPool(neg);
        assertFalse(mole.isWhitelisted(neg.toId()), "negative spacing pool was listed");

        // The panic is now unreachable: there is no listing to open against.
        vm.prank(alice);
        vm.expectRevert(MolePositions.PoolNotWhitelisted.selector);
        mole.open(k, -600, 600, 1e18, type(uint256).max, type(uint256).max, block.timestamp);
        vm.prank(alice);
        vm.expectRevert(MolePositions.PoolNotWhitelisted.selector);
        mole.open(neg, -600, 600, 1e18, type(uint256).max, type(uint256).max, block.timestamp);
    }

    /*==========================================================================
                     2. PERMISSIONLESS WHITELIST: HOOK REENTRANCY
    ==========================================================================*/

    /// @notice ATTACK: a hook running inside PoolManager.modifyLiquidity — i.e. inside MolePositions'
    ///         own unlock — is the strongest frame an attacker can reach, and this ReenteringHook is
    ///         armed to reenter open() from it. Under the fail-closed identity allowlist that frame no
    ///         longer exists: the hook pool cannot be whitelisted (the hook is not moleHook ==
    ///         address(0)), so the hook is never called inside a mole unlock and cannot reenter at all.
    ///         The reentry GUARDS themselves (AlreadyUnlocked / NotOwner / NotPoolManager) remain
    ///         proven on the admissible hookless path by test_attack_reentrantTokenCannotReenterDuringSettle,
    ///         which reenters from inside _settleFrom on a hookless pool. This test now proves the hook
    ///         attack is refused at admission — strictly stronger than "the reentry is caught".
    function test_attack_hostileHookCannotReenterMolePositions() public {
        address hookAddr = address(uint160(0x5555 << 144) | uint160(Hooks.BEFORE_ADD_LIQUIDITY_FLAG));
        deployCodeTo("AttackPoolAndTokens.t.sol:ReenteringHook", hookAddr);
        ReenteringHook hook = ReenteringHook(hookAddr);

        PoolKey memory k = PoolKey(c0, c1, 3000, 60, IHooks(hookAddr));
        manager.initialize(k, SQRT_PRICE_1_1);

        // Fully armed to reenter open() the instant it is called inside modifyLiquidity. It never will.
        hook.arm(
            address(mole),
            abi.encodeCall(
                MolePositions.open,
                (k, int24(-600), int24(600), 1e18, type(uint256).max, type(uint256).max, block.timestamp)
            )
        );
        assertTrue(hook.armed(), "hook must be armed for this to mean anything");

        // A real victim on the admissible hookless pool — the position the reentry would have targeted.
        vm.prank(alice);
        uint256 victim = mole.open(plainKey, -600, 600, 1e18, type(uint256).max, type(uint256).max, block.timestamp);
        uint256 countAfterVictim = mole.positionCount();

        // The hook pool is refused deny-by-default, so no position can be opened behind it and the hook
        // is never reached — no matter who asks.
        vm.prank(mallory);
        vm.expectRevert(MolePositions.HookNotPermitted.selector);
        mole.whitelistPool(k);
        assertFalse(mole.isWhitelisted(k.toId()), "reentering-hook pool must not be whitelisted");

        vm.prank(mallory);
        vm.expectRevert(MolePositions.PoolNotWhitelisted.selector);
        mole.open(k, -600, 600, 1e18, type(uint256).max, type(uint256).max, block.timestamp);

        // The armed attack never fired: the in-hook reentry frame does not exist.
        assertFalse(hook.fired(), "hook ran despite its pool never being listed");
        assertEq(mole.positionCount(), countAfterVictim, "a phantom position was created");
        assertEq(mole.ownerOf(victim), alice, "victim owner rewritten");
        assertEq(mole.getPosition(victim).liquidity, 1e18, "victim liquidity moved");
        _assertMoleHoldsNothing("after the reentering hook was refused admission");
    }

    /*==========================================================================
                             3. HOSTILE TOKENS
    ==========================================================================*/

    /// @notice ATTACK: fee-on-transfer. `_settleFrom` moves `amount`, the PoolManager receives 98%.
    ///         Defence holds: settle() credits only what arrived, the unlock ends with a non-zero
    ///         delta and everything rolls back. Verified no partial state survives.
    function test_attack_feeOnTransferTokenCannotOpen() public {
        FeeOnTransferToken fot = new FeeOnTransferToken();
        MockERC20 partner = new MockERC20("P", "P", 18);
        (Currency a, Currency b) = _sorted(address(fot), address(partner));
        PoolKey memory k = PoolKey(a, b, 3000, 60, IHooks(address(0)));
        manager.initialize(k, SQRT_PRICE_1_1);
        mole.whitelistPool(k);

        fot.mint(alice, 1e24);
        partner.mint(alice, 1e24);
        vm.startPrank(alice);
        fot.approve(address(mole), type(uint256).max);
        partner.approve(address(mole), type(uint256).max);
        vm.stopPrank();

        uint256 countBefore = mole.positionCount();

        vm.prank(alice);
        vm.expectRevert(IPoolManager.CurrencyNotSettled.selector);
        mole.open(k, -600, 600, 1e18, type(uint256).max, type(uint256).max, block.timestamp);

        assertEq(mole.positionCount(), countBefore, "position id was consumed by a failed open");
        assertEq(mole.positionsOf(alice).length, 0, "owner index polluted by a failed open");
        assertEq(fot.balanceOf(address(manager)), 0, "tokens stranded in the PoolManager");
    }

    /// @notice ATTACK / DESIGN COST: take() hardcodes positions[id].owner. If that owner is
    ///         blacklisted by the token afterwards, there is no other recipient anywhere in the
    ///         contract, no owner transfer and no rescue — the position is bricked forever.
    function test_attack_blacklistedOwnerIsPermanentlyStranded() public {
        BlacklistToken bl = new BlacklistToken();
        MockERC20 partner = new MockERC20("P", "P", 18);
        (Currency a, Currency b) = _sorted(address(bl), address(partner));
        PoolKey memory k = PoolKey(a, b, 3000, 60, IHooks(address(0)));
        manager.initialize(k, SQRT_PRICE_1_1);
        mole.whitelistPool(k);

        bl.mint(alice, 1e24);
        partner.mint(alice, 1e24);
        vm.startPrank(alice);
        bl.approve(address(mole), type(uint256).max);
        partner.approve(address(mole), type(uint256).max);
        vm.stopPrank();

        vm.prank(alice);
        uint256 id = mole.open(k, -600, 600, 1e18, type(uint256).max, type(uint256).max, block.timestamp);
        uint256 lockedBl = bl.balanceOf(address(manager));
        assertGt(lockedBl, 0, "nothing at stake");

        // Control: before the blacklist, the exit works.
        vm.prank(alice);
        mole.withdraw(id, 1);

        bl.blockAddress(alice);

        // Every exit that actually pays out fails, forever, because take() can only target alice.
        uint128[4] memory sizes = [uint128(1e6), uint128(1e12), uint128(1e17), uint128(1e18 - 2)];
        for (uint256 i; i < sizes.length; ++i) {
            vm.prank(alice);
            vm.expectPartialRevert(CustomRevert.WrappedError.selector);
            mole.withdraw(id, sizes[i]);
        }
        _warpBy(3650 days); // a decade later, same result
        vm.prank(alice);
        vm.expectPartialRevert(CustomRevert.WrappedError.selector);
        mole.withdraw(id, 1e18 - 1);

        // The only "successful" exit is one that pays nothing: liquidity is burnt for zero tokens.
        uint256 blBefore = bl.balanceOf(alice);
        vm.prank(alice);
        mole.withdraw(id, 1);
        assertEq(bl.balanceOf(alice), blBefore, "dust exit paid something");
        assertEq(mole.getPosition(id).liquidity, 1e18 - 2, "liquidity should still be locked");
        assertEq(mole.ownerOf(id), alice, "and the payout target can never change");
        assertGt(bl.balanceOf(address(manager)), 0, "value is still sitting in the PoolManager");
    }

    /// @notice ATTACK: a token whose balance shrinks after settle. The PoolManager's reserves no
    ///         longer cover the recorded deltas, so take() fails and exits brick for that currency.
    ///         Contained to the hostile currency, but permanent for everyone holding it.
    function test_attack_rebasingTokenBricksExitsForThatPool() public {
        RebasingToken rb = new RebasingToken();
        MockERC20 partner = new MockERC20("P", "P", 18);
        (Currency a, Currency b) = _sorted(address(rb), address(partner));
        PoolKey memory k = PoolKey(a, b, 3000, 60, IHooks(address(0)));
        manager.initialize(k, SQRT_PRICE_1_1);
        mole.whitelistPool(k);

        rb.mint(alice, 1e24);
        partner.mint(alice, 1e24);
        vm.startPrank(alice);
        rb.approve(address(mole), type(uint256).max);
        partner.approve(address(mole), type(uint256).max);
        vm.stopPrank();

        vm.prank(alice);
        uint256 id = mole.open(k, -600, 600, 1e18, type(uint256).max, type(uint256).max, block.timestamp);

        // The token issuer rebases the PoolManager's balance down to (almost) nothing.
        uint256 held = rb.balanceOf(address(manager));
        rb.shrink(address(manager), held - 1);

        vm.prank(alice);
        vm.expectPartialRevert(CustomRevert.WrappedError.selector);
        mole.withdraw(id, 1e18);
    }

    /// @notice ATTACK: ERC-777 style token reenters MolePositions in the middle of `_settleFrom`,
    ///         i.e. between sync() and settle(). Every reentry is stopped by v4's global lock.
    function test_attack_reentrantTokenCannotReenterDuringSettle() public {
        (PoolKey memory k, ReentrantToken re,) = _reentrantPool();

        // Reenter open(): must hit AlreadyUnlocked and leave no phantom position behind.
        re.arm(address(mole), abi.encodeCall(
                MolePositions.open, (k, int24(-600), int24(600), 1e18, type(uint256).max, type(uint256).max, block.timestamp)
            ));
        vm.prank(alice);
        uint256 id = mole.open(k, -600, 600, 1e18, type(uint256).max, type(uint256).max, block.timestamp);
        assertFalse(re.innerOk(), "reentrant open must fail");
        assertEq(bytes4(re.innerReturn()), IPoolManager.AlreadyUnlocked.selector, "expected AlreadyUnlocked");
        assertEq(mole.positionCount(), id, "phantom position created");

        // Reenter withdraw() on the position being funded right now: blocked by the owner check.
        re.arm(address(mole), abi.encodeCall(MolePositions.withdraw, (id, 1e18)));
        vm.prank(alice);
        mole.open(k, -600, 600, 1e17, type(uint256).max, type(uint256).max, block.timestamp);
        assertFalse(re.innerOk(), "reentrant withdraw must fail");
        assertEq(bytes4(re.innerReturn()), MolePositions.NotOwner.selector, "expected NotOwner");
        assertEq(mole.getPosition(id).liquidity, 1e18, "victim liquidity moved");

        // Reenter unlockCallback() directly from inside the PoolManager's own unlock.
        re.arm(
            address(mole),
            abi.encodeCall(
                MolePositions.unlockCallback,
                (abi.encode(MolePositions.Action.Withdraw, id, address(this), -int256(1e18), int24(0), int24(0)))
            )
        );
        vm.prank(alice);
        mole.open(k, -600, 600, 1e17, type(uint256).max, type(uint256).max, block.timestamp);
        assertFalse(re.innerOk(), "direct unlockCallback must fail");
        assertEq(bytes4(re.innerReturn()), MolePositions.NotPoolManager.selector, "expected NotPoolManager");
        assertEq(mole.getPosition(id).liquidity, 1e18, "victim liquidity moved");
    }

    /// @notice ATTACK: the token steals the settle() credit for the payment MolePositions just made,
    ///         by calling PoolManager.settle() itself before MolePositions can. The credit really is
    ///         hijackable — but the position's debt then goes unsettled and the unlock reverts, so it
    ///         fails closed rather than misattributing.
    function test_attack_reentrantTokenHijackingSettleCreditFailsClosed() public {
        (PoolKey memory k, ReentrantToken re,) = _reentrantPool();

        re.arm(address(manager), abi.encodeWithSignature("settle()"));
        vm.prank(alice);
        vm.expectRevert(IPoolManager.CurrencyNotSettled.selector);
        mole.open(k, -600, 600, 1e18, type(uint256).max, type(uint256).max, block.timestamp);
    }

    /// @notice ATTACK: the token re-syncs a *different* currency mid-transfer so that MolePositions'
    ///         settle() credits the wrong currency. Fails closed too.
    function test_attack_reentrantTokenResyncingOtherCurrencyFailsClosed() public {
        (PoolKey memory k, ReentrantToken re, MockERC20 partner) = _reentrantPool();

        re.arm(address(manager), abi.encodeWithSignature("sync(address)", address(partner)));
        vm.prank(alice);
        vm.expectRevert(IPoolManager.CurrencyNotSettled.selector);
        mole.open(k, -600, 600, 1e18, type(uint256).max, type(uint256).max, block.timestamp);
    }

    function _reentrantPool() internal returns (PoolKey memory k, ReentrantToken re, MockERC20 partner) {
        re = new ReentrantToken();
        partner = new MockERC20("P", "P", 18);
        (Currency a, Currency b) = _sorted(address(re), address(partner));
        k = PoolKey(a, b, 3000, 60, IHooks(address(0)));
        manager.initialize(k, SQRT_PRICE_1_1);
        mole.whitelistPool(k);

        re.mint(alice, 1e24);
        partner.mint(alice, 1e24);
        vm.startPrank(alice);
        re.approve(address(mole), type(uint256).max);
        partner.approve(address(mole), type(uint256).max);
        vm.stopPrank();
    }

    /// @notice ATTACK: a token that inflates the PoolManager's apparent balance so settle() credits
    ///         twice what was paid. The surplus is real credit inside the PoolManager, but
    ///         MolePositions never `take`s it on the open path, so the unlock ends non-zero and the
    ///         whole transaction unwinds. Fails closed.
    function test_attack_overCreditingTokenCannotMintCredit() public {
        OverCreditToken oc = new OverCreditToken();
        oc.setPoolManager(address(manager));
        MockERC20 partner = new MockERC20("P", "P", 18);
        (Currency a, Currency b) = _sorted(address(oc), address(partner));
        PoolKey memory k = PoolKey(a, b, 3000, 60, IHooks(address(0)));
        manager.initialize(k, SQRT_PRICE_1_1);
        mole.whitelistPool(k);

        oc.mint(alice, 1e24);
        partner.mint(alice, 1e24);
        vm.startPrank(alice);
        oc.approve(address(mole), type(uint256).max);
        partner.approve(address(mole), type(uint256).max);
        vm.stopPrank();

        vm.prank(alice);
        vm.expectRevert(IPoolManager.CurrencyNotSettled.selector);
        mole.open(k, -600, 600, 1e18, type(uint256).max, type(uint256).max, block.timestamp);
        assertEq(mole.positionCount(), 0, "position survived a failed open");
    }

    /*==========================================================================
                     4b. ORDERING-PRIVILEGED SEQUENCER (RH chain)
    ==========================================================================*/

    /// @notice ATTACK, STILL SUCCEEDS against a caller who passes an unbounded max — reported as a
    ///         residual finding, not converted. Name kept for traceability with the 2026-08-01 run,
    ///         although "has no amount bound" is no longer literally true: open() now takes
    ///         amount0Max / amount1Max. `open()` still names a LIQUIDITY amount and accepts whatever
    ///         token mix the pool decides that costs, so on a chain with one centralised sequencer and
    ///         no public mempool (RHChain) the party that orders transactions still chooses the basket
    ///         — for any caller who passes type(uint256).max. The second half pins what changed: a
    ///         caller who names a ceiling now gets a revert instead of a silent fill.
    function test_attack_openHasNoAmountBoundSoOrderingChangesTheBill() public {
        uint256 a0 = t0.balanceOf(alice);
        uint256 a1 = t1.balanceOf(alice);
        vm.prank(alice);
        mole.open(plainKey, -6000, 6000, 1e18, type(uint256).max, type(uint256).max, block.timestamp);
        uint256 fair0 = a0 - t0.balanceOf(alice);
        uint256 fair1 = a1 - t1.balanceOf(alice);
        console2.log("fair c0", fair0);
        console2.log("fair c1", fair1);

        // Sequencer inserts its own swap first, pushing the price under the user's range.
        _swapExactIn(plainKey, true, 4e20);

        a0 = t0.balanceOf(alice);
        a1 = t1.balanceOf(alice);
        vm.prank(alice);
        mole.open(plainKey, -6000, 6000, 1e18, type(uint256).max, type(uint256).max, block.timestamp); // byte-identical call
        uint256 got0 = a0 - t0.balanceOf(alice);
        uint256 got1 = a1 - t1.balanceOf(alice);
        console2.log("sandwiched c0", got0);
        console2.log("sandwiched c1", got1);

        // Same call, wildly different basket, for a caller who bounded nothing.
        assertGt(got0, fair0 * 2, "c0 outlay should have exploded");
        assertLt(got1, fair1 / 2, "c1 outlay should have collapsed");

        // MITIGATION, pinned. The same post-sandwich open, from a caller who allows 50% slippage on
        // the c0 leg, reverts rather than filling at the sequencer's price. The loss becomes a failed
        // transaction — which is the whole point of the bound.
        uint256 guarded0 = t0.balanceOf(alice);
        uint256 guarded1 = t1.balanceOf(alice);
        vm.prank(alice);
        vm.expectRevert(MolePositions.ExceedsMaxAmount.selector);
        mole.open(plainKey, -6000, 6000, 1e18, fair0 * 3 / 2, type(uint256).max, block.timestamp);
        assertEq(t0.balanceOf(alice), guarded0, "bounded open still spent c0");
        assertEq(t1.balanceOf(alice), guarded1, "bounded open still spent c1");

        // And the deadline is a real gate too, so a held-back transaction expires instead of landing
        // at a price chosen an hour later.
        vm.prank(alice);
        vm.expectRevert(MolePositions.DeadlinePassed.selector);
        mole.open(plainKey, -6000, 6000, 1e18, type(uint256).max, type(uint256).max, block.timestamp - 1);
    }

    /// @notice ATTACK: decimals extremes. MolePositions does no unit conversion anywhere, so 0 and 24
    ///         decimal tokens behave exactly like 18. No decimals assumption to break.
    function test_attack_extremeDecimalsChangeNothing() public {
        MockERC20 zero = new MockERC20("Z", "Z", 0);
        MockERC20 big = new MockERC20("W", "W", 24);
        (Currency a, Currency b) = _sorted(address(zero), address(big));
        PoolKey memory k = PoolKey(a, b, 3000, 60, IHooks(address(0)));
        manager.initialize(k, SQRT_PRICE_1_1);
        mole.whitelistPool(k);

        zero.mint(alice, 1e24);
        big.mint(alice, 1e24);
        vm.startPrank(alice);
        zero.approve(address(mole), type(uint256).max);
        big.approve(address(mole), type(uint256).max);
        vm.stopPrank();

        vm.prank(alice);
        uint256 id = mole.open(k, -600, 600, 1e18, type(uint256).max, type(uint256).max, block.timestamp);
        vm.prank(alice);
        mole.withdraw(id, 1e18);
        assertEq(mole.getPosition(id).liquidity, 0);
        assertEq(MockERC20(Currency.unwrap(a)).balanceOf(address(mole)), 0, "residue retained");
        assertEq(MockERC20(Currency.unwrap(b)).balanceOf(address(mole)), 0, "residue retained");
    }

    /*==========================================================================
                                4. TICK EDGES
    ==========================================================================*/

    function test_attack_tickEdgeCasesAllRevertCleanly() public {
        vm.startPrank(alice);

        vm.expectRevert(MolePositions.TicksMisordered.selector);
        mole.open(plainKey, 600, 600, 1e18, type(uint256).max, type(uint256).max, block.timestamp); // equal

        vm.expectRevert(MolePositions.TicksMisordered.selector);
        mole.open(plainKey, 600, -600, 1e18, type(uint256).max, type(uint256).max, block.timestamp); // inverted

        vm.expectRevert(MolePositions.TickNotOnSpacing.selector);
        mole.open(plainKey, -601, 600, 1e18, type(uint256).max, type(uint256).max, block.timestamp);

        vm.expectRevert(MolePositions.TickNotOnSpacing.selector);
        mole.open(plainKey, -600, 601, 1e18, type(uint256).max, type(uint256).max, block.timestamp);

        // MIN_TICK / MAX_TICK are not multiples of 60, so they are rejected on spacing first.
        vm.expectRevert(MolePositions.TickNotOnSpacing.selector);
        mole.open(plainKey, TickMath.MIN_TICK, 600, 1e18, type(uint256).max, type(uint256).max, block.timestamp);
        vm.expectRevert(MolePositions.TickNotOnSpacing.selector);
        mole.open(plainKey, -600, TickMath.MAX_TICK, 1e18, type(uint256).max, type(uint256).max, block.timestamp);

        // On-spacing but outside v4's tick domain -> RangeWidthOutOfBounds.
        vm.expectRevert(MolePositions.RangeWidthOutOfBounds.selector);
        mole.open(plainKey, -887_280, 600, 1e18, type(uint256).max, type(uint256).max, block.timestamp);
        vm.expectRevert(MolePositions.RangeWidthOutOfBounds.selector);
        mole.open(plainKey, -600, 887_280, 1e18, type(uint256).max, type(uint256).max, block.timestamp);

        // Width bounds: wider than maxRangeWidth.
        vm.expectRevert(MolePositions.RangeWidthOutOfBounds.selector);
        mole.open(plainKey, -120_000, 120_000, 1e18, type(uint256).max, type(uint256).max, block.timestamp);

        // The narrowest legal range on this pool is exactly minRangeWidth, so it is accepted.
        uint256 id = mole.open(plainKey, -60, 0, 1e18, type(uint256).max, type(uint256).max, block.timestamp);
        assertEq(mole.getPosition(id).liquidity, 1e18);
        vm.stopPrank();
    }

    /// @notice ATTACK: whitelist a pool whose tickSpacing exceeds the immutable maxRangeWidth. Every
    ///         legal range in that pool is wider than the contract will accept, so the pool is dead
    ///         on arrival. Permissionless whitelisting means anyone can advertise such a pool.
    function test_attack_tickSpacingAboveMaxRangeWidthMakesPoolUnusable() public {
        MolePositions narrow = deployMoleVault(manager, keeper, MIN_INTERVAL, 60, 100, address(0), 0, 0, 0, 0, 10_000, 0, 0, address(0));

        PoolKey memory k = PoolKey(c0, c1, 3000, 200, IHooks(address(0)));
        manager.initialize(k, SQRT_PRICE_1_1);
        vm.prank(mallory);
        narrow.whitelistPool(k);

        vm.startPrank(alice);
        t0.approve(address(narrow), type(uint256).max);
        t1.approve(address(narrow), type(uint256).max);
        vm.expectRevert(MolePositions.RangeWidthOutOfBounds.selector);
        narrow.open(k, -200, 0, 1e18, type(uint256).max, type(uint256).max, block.timestamp); // narrowest legal range is 200 > maxRangeWidth 100
        vm.expectRevert(MolePositions.RangeWidthOutOfBounds.selector);
        narrow.open(k, -400, -200, 1e18, type(uint256).max, type(uint256).max, block.timestamp);
        vm.stopPrank();
    }

    /*==========================================================================
              5. REBALANCE ACCOUNTING — the shared, unowned contract balance
    ==========================================================================*/

    /// @notice REGRESSION (was test_attack_rebalanceConfiscatesAccruedFeesFromTheOwner).
    ///         Used to prove: a same-range rebalance swept the owner's accrued fees into
    ///         address(this) — an unowned pot no function could ever pay out — leaving the rebalanced
    ///         owner exactly that much poorer than an identical never-rebalanced control. Now pins
    ///         the two properties that killed it:
    ///           (1) the contract's token balance is EXACTLY ZERO at every point of the sequence.
    ///               That number is precisely what the deleted _settleNet used to accumulate.
    ///           (2) a same-range rebalance INCREASES the position's liquidity, because the fees that
    ///               used to be swept are now re-minted into the owner's own position.
    ///         The control position is kept: it is what turns "alice got paid" into "alice got paid
    ///         the same as someone the keeper never touched".
    function test_regression_rebalanceCompoundsFeesAndLeavesNothingInTheContract() public {
        // Measured over the WHOLE sequence, because part of what the rebalance returns is paid to the
        // owner immediately as dust. Counting only the final withdrawal would under-report alice.
        uint256 aliceStart0 = t0.balanceOf(alice);
        uint256 aliceStart1 = t1.balanceOf(alice);
        uint256 controlStart0 = t0.balanceOf(mallory);
        uint256 controlStart1 = t1.balanceOf(mallory);

        vm.prank(alice);
        uint256 victim = mole.open(plainKey, -6000, 6000, 1e20, type(uint256).max, type(uint256).max, block.timestamp); // will be rebalanced
        vm.prank(mallory);
        uint256 control = mole.open(plainKey, -6000, 6000, 1e20, type(uint256).max, type(uint256).max, block.timestamp); // identical, never rebalanced

        for (uint256 i; i < 12; ++i) {
            _swapExactIn(plainKey, i % 2 == 0, 1e18);
        }

        _assertMoleHoldsNothing("before the rebalance");
        uint256 preRebalance0 = t0.balanceOf(alice);
        uint256 preRebalance1 = t1.balanceOf(alice);

        _warpBy(MIN_INTERVAL + 1);
        vm.prank(keeper);
        mole.rebalance(victim, -6000, 6000); // SAME range: only fees can move

        // (1) nothing was swept anywhere. This single line is the whole fix: it is exactly the
        //     number the deleted _settleNet used to accumulate.
        _assertMoleHoldsNothing("after the rebalance");

        // (2) the fees landed in the owner's position instead: same range, more liquidity.
        uint128 compounded = mole.getPosition(victim).liquidity;
        console2.log("liquidity before rebalance", uint256(1e20));
        console2.log("liquidity after  rebalance", uint256(compounded));
        assertGt(compounded, 1e20, "same-range rebalance must compound fees into the position");
        assertEq(mole.getPosition(control).liquidity, 1e20, "control must not have moved");

        // (3) whatever did not fit back into the position went to the OWNER, which is the other half
        //     of "no inventory": the residue has a name on it now.
        uint256 dust0 = t0.balanceOf(alice) - preRebalance0;
        uint256 dust1 = t1.balanceOf(alice) - preRebalance1;
        console2.log("dust paid to the owner c0", dust0);
        console2.log("dust paid to the owner c1", dust1);
        assertGt(dust0 + dust1, 0, "the mint round-down residue went somewhere other than the owner");

        // The liquidity NUMBER is no longer invariant across a rebalance, so an exit takes the
        // current liquidity. Asking for the literal 1e20 would leave the compounded remainder behind.
        vm.prank(alice);
        mole.withdraw(victim, compounded);
        vm.prank(mallory);
        mole.withdraw(control, 1e20);

        uint256 aliceNet0 = t0.balanceOf(alice) - aliceStart0;
        uint256 aliceNet1 = t1.balanceOf(alice) - aliceStart1;
        uint256 controlNet0 = t0.balanceOf(mallory) - controlStart0;
        uint256 controlNet1 = t1.balanceOf(mallory) - controlStart1;

        console2.log("rebalanced owner net c0", aliceNet0);
        console2.log("control     owner net c0", controlNet0);
        console2.log("rebalanced owner net c1", aliceNet1);
        console2.log("control     owner net c1", controlNet1);

        // Both LPs earned fees on identical positions, so both must end up ahead by the same amount.
        assertGt(aliceNet0 + aliceNet1, 0, "rebalanced owner earned nothing");

        // Being rebalanced is no longer expensive. It used to cost the owner ~1.5e15 per currency —
        // their entire fee take. What is left is v4 round-down dust on the extra burn/mint.
        assertApproxEqAbs(aliceNet0, controlNet0, 16, "rebalanced owner lost more than dust in c0");
        assertApproxEqAbs(aliceNet1, controlNet1, 16, "rebalanced owner lost more than dust in c1");

        // And nothing is stranded after both owners have fully exited.
        _assertMoleHoldsNothing("after both owners exited");
        assertEq(mole.getPosition(victim).liquidity, 0);
        assertEq(mole.getPosition(control).liquidity, 0);
    }

    /// @notice REGRESSION (was test_attack_keeperDrainsStrandedPotIntoAttackerWallet), and this is
    ///         the one that used to falsify the headline claim.
    ///         Used to prove: the confiscated pot was shared and unowned, `_settleNet` would spend it
    ///         to cover the DEFICIT of any other position's widening rebalance, so a compromised
    ///         keeper widened its own narrow position at constant liquidity, the pot paid the
    ///         difference (+1.28e15 in both currencies, 78% of the pot in one shot) and the attacker
    ///         withdrew it legitimately as the stored owner.
    ///         Now pins: the identical four-step sequence runs to completion and the attacker ends
    ///         POORER, because there is no pot at any point and a widening rebalance can only be
    ///         funded by the burn that immediately preceded it.
    function test_regression_keeperCannotMoveValueBetweenPositions() public {
        // 1. An honest LP earns fees; the keeper rebalances them. This is the step that used to
        //    create the pot.
        uint256 v0 = t0.balanceOf(alice);
        uint256 v1 = t1.balanceOf(alice);
        vm.prank(alice);
        uint256 victim = mole.open(plainKey, -6000, 6000, 1e20, type(uint256).max, type(uint256).max, block.timestamp);
        for (uint256 i; i < 12; ++i) {
            _swapExactIn(plainKey, i % 2 == 0, 1e18);
        }
        _warpBy(MIN_INTERVAL + 1);
        vm.prank(keeper);
        mole.rebalance(victim, -6000, 6000);

        _assertMoleHoldsNothing("after the victim's rebalance");
        assertGt(mole.getPosition(victim).liquidity, 1e20, "the victim's fees must stay in the victim's position");

        // 2. The attacker opens the cheapest legal position: the narrowest range allowed.
        uint256 m0 = t0.balanceOf(mallory);
        uint256 m1 = t1.balanceOf(mallory);
        vm.prank(mallory);
        uint256 id = mole.open(plainKey, -60, 60, 5e15, type(uint256).max, type(uint256).max, block.timestamp);

        // 3. The compromised keeper widens it — the exact call that used to be funded by the pot.
        _warpBy(MIN_INTERVAL + 1);
        vm.prank(keeper);
        mole.rebalance(id, -6000, 6000);
        _assertMoleHoldsNothing("after the attacker's widening rebalance");

        // Widening at constant TOKEN AMOUNTS means far LESS liquidity, which is the arithmetic that
        // makes the theft impossible: the wide range is bought with the attacker's own burnt tokens.
        uint128 widened = mole.getPosition(id).liquidity;
        console2.log("attacker liquidity before widening", uint256(5e15));
        console2.log("attacker liquidity after  widening", uint256(widened));
        assertLt(widened, 5e15, "widening must cost liquidity, not conserve it");

        // The old exploit's exit — withdrawing the ORIGINAL 5e15 out of a widened position — is now
        // arithmetically impossible, and the contract says so rather than paying it out of a pot.
        vm.prank(mallory);
        vm.expectRevert(MolePositions.InsufficientLiquidity.selector);
        mole.withdraw(id, 5e15);

        // 4. The attacker takes the legitimate maximum instead.
        vm.prank(mallory);
        mole.withdraw(id, widened);

        int256 gain0 = int256(t0.balanceOf(mallory)) - int256(m0);
        int256 gain1 = int256(t1.balanceOf(mallory)) - int256(m1);
        console2.log("attacker net c0", gain0);
        console2.log("attacker net c1", gain1);

        // The whole point: a compromised keeper cannot take a token. The attacker is not richer.
        assertLe(gain0, 0, "attacker profited in c0");
        assertLe(gain1, 0, "attacker profited in c1");
        assertLt(gain0 + gain1, 0, "round trip through the keeper must not be free");
        _assertMoleHoldsNothing("after the attacker exited");

        // ...and the victim is still whole: their fees are still theirs, not in a pot and not in
        // mallory's wallet.
        uint128 victimLive = mole.getPosition(victim).liquidity; // read first: prank applies to one call
        vm.prank(alice);
        mole.withdraw(victim, victimLive);
        assertGt(t0.balanceOf(alice) + t1.balanceOf(alice), v0 + v1, "victim did not keep their fees");
        _assertMoleHoldsNothing("after every position closed");
    }

    /// @notice REGRESSION (was test_attack_rebalanceWithNoContractBalanceReverts).
    ///         Used to prove: the keeper's only function did not work on a freshly deployed contract,
    ///         because holding L constant made a widening rebalance short of tokens and _settleFrom
    ///         then tried to pay the difference out of a zero balance (TransferFailed). Now pins the
    ///         opposite semantics: deriving L from the amounts the burn returned makes a widening
    ///         rebalance self-funding by construction, on a contract that holds — and keeps — nothing.
    function test_regression_wideningRebalanceIsSelfFundingWithZeroContractBalance() public {
        uint256 before0 = t0.balanceOf(alice);
        uint256 before1 = t1.balanceOf(alice);

        vm.prank(alice);
        uint256 id = mole.open(plainKey, -600, 600, 1e18, type(uint256).max, type(uint256).max, block.timestamp);
        _assertMoleHoldsNothing("before the widening rebalance");

        vm.warp(block.timestamp + 2 hours);
        vm.prank(keeper);
        mole.rebalance(id, -6000, 6000); // 10x wider, on a contract with a zero balance

        _assertMoleHoldsNothing("after the widening rebalance");

        // Same tokens across a 10x wider range buy roughly a tenth of the liquidity. The number
        // changing is correct behaviour, not a loss: value is in the tokens, not in the integer.
        uint128 widened = mole.getPosition(id).liquidity;
        console2.log("liquidity after widening", uint256(widened));
        assertLt(widened, 1e18, "widening must reduce the liquidity number");
        assertGt(widened, 0, "position was destroyed");
        assertEq(mole.getPosition(id).tickLower, -6000, "range did not move");
        assertEq(mole.getPosition(id).tickUpper, 6000, "range did not move");

        vm.prank(alice);
        mole.withdraw(id, widened);
        assertEq(mole.getPosition(id).liquidity, 0, "position not closed");

        // A rebalance is delta-neutral bar v4's round-down dust, so the owner's round trip through
        // open -> rebalance -> withdraw costs a few wei and nothing more.
        assertLe(before0 - t0.balanceOf(alice), 16, "widening rebalance cost the owner c0");
        assertLe(before1 - t1.balanceOf(alice), 16, "widening rebalance cost the owner c1");
        _assertMoleHoldsNothing("after the owner exited");
    }
}

library PoolManagerBytecode {
    bytes internal constant CREATION = hex"60a03460a057601f6143b838819003918201601f19168301916001600160401b0383118484101760a45780849260209460405283398101031260a057516001600160a01b0381169081900360a0575f80546001600160a01b0319168217815560405191907f8be0079c531659141344cd1fd0a4f28419497f9722a3daafe3b4186f6b6457e08180a3306080526142ff90816100b98239608051816124550152f35b5f80fd5b634e487b7160e01b5f52604160045260245ffdfe60a0806040526004361015610012575f80fd5b5f3560e01c908162fdd58e14611f3a5750806301ffc9a714611ee4578063095bcdb614611e5d5780630b0d9c0914611e0257806311da60b414611dd8578063156e29f614611d535780631e2eaeaf14611d37578063234266d714611b3f5780632d77138914611acd57806335fd631a14611a775780633dd45adb14611a44578063426a8493146119ca57806348c8949114611833578063527596511461178f578063558a7297146116fd578063598af9e7146116a35780635a6bcfda14610dd15780636276cbbe14610b135780637e87ce7d14610a4357806380f0b44c146109c85780638161b874146108fb5780638da5cb5b146108d457806397e8cd4e1461089c5780639bf6645f1461084f578063a5841194146107d5578063b6363cf21461077e578063dbd035ff14610728578063f02de3b214610700578063f135baaa146106e4578063f2fde38b1461066f578063f3cd914c14610407578063f5298aca146102e45763fe99049a14610186575f80fd5b346102e05760803660031901126102e05761019f611f79565b6101a7611f8f565b60443591606435916001600160a01b03909116905f8051602061426a833981519152906102449033841415806102bd575b610252575b835f52600460205260405f20865f5260205260405f206101fe868254612159565b905560018060a01b031693845f52600460205260405f20865f5260205260405f2061022a828254612166565b905560408051338152602081019290925290918291820190565b0390a4602060405160018152f35b5f84815260056020908152604080832033845282528083208984529091529020548560018201610284575b50506101dd565b61028d91612159565b845f52600560205260405f2060018060a01b0333165f5260205260405f20875f5260205260405f20555f8561027d565b505f84815260036020908152604080832033845290915290205460ff16156101d8565b5f80fd5b346102e0576102f236611fa5565b5f8051602061428a8339815191525c156103f8575f8051602061426a8339815191526103705f9360018060a01b03169461033661032e856121ce565b3390886121ef565b6001600160a01b03169233841415806103d6575b610375575b8385526004602052604085208686526020526040852061022a828254612159565b0390a4005b838552600560209081526040808720338852825280872088885290915285205481861982036103a6575b505061034f565b6103af91612159565b8486526005602090815260408088203389528252808820898952909152862055868161039f565b5083855260036020908152604080872033885290915285205460ff161561034a565b6354e3ca0d60e01b5f5260045ffd5b346102e0576101203660031901126102e05761042236612053565b60603660a31901126102e0576040519061043b82611fea565b60a43580151581036102e057825260c435602083019081529060e435906001600160a01b03821682036102e05760408401918252610104356001600160401b0381116102e05761048f9036906004016120da565b9290935f8051602061428a8339815191525c156103f8576104ae612453565b51156106605760a0822092835f52600660205260405f20906104cf82612494565b60808401958482828a600160a01b600190038b5116936104ee946128cc565b90949195606088015160020b908b51151590600160a01b60019003905116916040519861051a8a612005565b895260208901526040880152606087015262ffffff166080860152885115155f149862ffffff610607986105636105f49860209d61064d578a516001600160a01b031695613367565b94929682919261062e575b505060018060a01b03845116938e6001600160801b0360408301511691015160020b90604051958860801d600f0b875288600f0b60208801526040870152606086015260808501521660a08301527f40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f60c03393a3885187906001600160a01b0316612a39565b8094919461060f575b5050823391612535565b604051908152f35b9051610627916001600160a01b039091169083612535565b84806105fd565b60018060a01b03165f5260018f5260405f209081540190558e8061056e565b8a8e01516001600160a01b031695613367565b63be8b850760e01b5f5260045ffd5b346102e05760203660031901126102e057610688611f79565b5f549061069f336001600160a01b03841614612173565b60018060a01b031680916bffffffffffffffffffffffff60a01b16175f55337f8be0079c531659141344cd1fd0a4f28419497f9722a3daafe3b4186f6b6457e05f80a3005b346102e05760203660031901126102e0576004355c5f5260205ff35b346102e0575f3660031901126102e0576002546040516001600160a01b039091168152602090f35b346102e05761073636612107565b6040519160408360208152836020820152019160051b8301916020806040850193925b8335548152019101908483821015610775575060208091610759565b60408186030190f35b346102e05760403660031901126102e057610797611f79565b61079f611f8f565b9060018060a01b03165f52600360205260405f209060018060a01b03165f52602052602060ff60405f2054166040519015158152f35b346102e05760203660031901126102e0576107ee611f79565b6001600160a01b03811690816108125750505f5f8051602061424a8339815191525d005b61081b90612840565b905f8051602061424a8339815191525d7f1e0745a7db1623981f0b2a5d4232364c00787266eb75ad546f190e6cebe9bd955d005b346102e05761085d36612107565b6040519160408360208152836020820152019160051b8301916020806040850193925b83355c8152019101908483821015610775575060208091610880565b346102e05760203660031901126102e0576001600160a01b036108bd611f79565b165f526001602052602060405f2054604051908152f35b346102e0575f3660031901126102e0575f546040516001600160a01b039091168152602090f35b346102e05760603660031901126102e057610914611f79565b61091c611f8f565b600254604435906001600160a01b031633036109b9576001600160a01b03821680151580610999575b61098a5760209361060792806109825750815f526001855260405f20549384925b5f526001865260405f2061097b848254612159565b905561227a565b938492610966565b6318f3cb2960e31b5f5260045ffd5b505f8051602061424a8339815191525c6001600160a01b03168114610945565b6348f5c3ed60e01b5f5260045ffd5b346102e05760403660031901126102e0576109e1611f79565b5f8051602061428a8339815191525c156103f857335f9081526001600160a01b038216602052604090205c610a176024356121ce565b9081600f0b03610a3457610a329133915f03600f0b906121ef565b005b63bda73abf60e01b5f5260045ffd5b346102e05760c03660031901126102e057610a5d36612053565b610a65612041565b6002549091906001600160a01b031633036109b957623e900062fff0008316106103e9610fff8416101615610afb57602060a07fe9c42593e71f84403b84352cd168d693e2c9fcd1fdbcc3feb21d92b43e6696f9922092835f526006825260405f20610ad081612494565b805462ffffff60b81b191660b883901b62ffffff60b81b1617905560405162ffffff919091168152a2005b62ffffff8263a7abe2f760e01b5f521660045260245ffd5b346102e05760c03660031901126102e057610b2d36612053565b60a435906001600160a01b0382168083036102e057610b4a612453565b6060820191825160020b617fff8113610dbf5750825160020b60018112610dad5750805160208201805190916001600160a01b03908116911680821015610d8f575050608082019060018060a01b03825116906040840191610bb262ffffff84511682612772565b15610d7d5750610bc762ffffff835116612823565b83519097906001600160a01b0381169033829003610d2a575b505060a085205f8181526006602052604090208054919290916001600160a01b0316610d1b576020997fdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d643892610c3660a0936130e2565b9162ffffff60d01b9060d01b168a62ffffff851b84861b161717905562ffffff600180841b0389511695600180851b03905116965116995160020b600180841b03885116906040519b8c528c8c015260408b01528860608b015260020b98896080820152a4516001600160a01b0381169033829003610cba575b8585604051908152f35b61100016610cc9575b80610cb0565b610d1292610cf060405193636fe7e6eb60e01b8886015233602486015260448501906124b4565b60e4830152836101048301526101048252610d0d61012483612020565b612b5b565b50828080610cc3565b637983c05160e01b5f5260045ffd5b61200016610d39575b80610be0565b604051636e4c1aa760e11b6020820152336024820152610d7691610d6060448301896124b4565b8860e483015260e48252610d0d61010483612020565b5088610d33565b630732d7b560e51b5f5260045260245ffd5b60449250604051916306e6c98360e41b835260048301526024820152fd5b631d3d20b160e31b5f5260045260245ffd5b6316e0049f60e31b5f5260045260245ffd5b346102e0576101403660031901126102e057610dec36612053565b60803660a31901126102e05760405190610e0582611fcf565b60a4358060020b81036102e057825260c4358060020b81036102e057602083015260e4356040830152610104356060830152610124356001600160401b0381116102e057610e579036906004016120da565b90925f8051602061428a8339815191525c156103f857610e75612453565b60a0832093845f52600660205260405f20608052610e94608051612494565b60808401516001600160a01b03811690338290036115ee575b5050815160020b92602083015160020b91610ecb60408501516125f6565b93606087015160020b9760608201516040519960c08b018b81106001600160401b038211176115da57604052338b528860208c01528660408c015287600f0b60608c015260808b015260a08a01525f91858812156115bc57620d89e71988126115a957620d89e886136115965760405192610f4584611fcf565b5f84525f60208501525f60408501525f606085015287600f0b611373575b600460805101978960020b5f528860205260405f20988860020b5f5260205260405f206080515460a01c60020b8b81125f1461131d575060028060018c0154600184015490039b015491015490039b5b60a0600180821b03825116910151906040519160268301528960068301528b600383015281525f603a600c83012091816040820152816020820152525f5260066080510160205260405f20976001600160801b038954169982600f0b155f146112e1578a156112d25761106061105a60409f9b6111219c6111339e5b60018301956110526002611046848a548503613d76565b95019283548503613d76565b9655556121ce565b916121ce565b6001600160801b03169060801b179a8b965f84600f0b12611264575b5082600f0b611160575b5050506110ac61109d8560801d8360801d016125f6565b9185600f0b90600f0b016125f6565b6001600160801b03169060801b1791815160020b90602083015160020b8c8401516060850151918e5194855260208501528d84015260608301527ff208f4912782fd25c7f114ca3723a2d5dd6f3bcc3ac8db5af63baa85f711d5ec60803393a3608089015189906001600160a01b0316612674565b8094919461113f575b50833391612535565b82519182526020820152f35b608082015161115a916001600160a01b039091169083612535565b8561112a565b6080515492935090916001600160a01b0381169060a01c60020b828112156111b9575050906111ad926111a26111986111a894612cb9565b91600f0b92612cb9565b90613031565b6125f6565b60801b5b8b8080611086565b92809193125f1461123a576111f8916111e56111a86111a8936111df88600f0b91612cb9565b87613031565b936111f386600f0b92612cb9565b612fe6565b6001600160801b03169060801b17906001600160801b0361122560036080510192600f0b82845416613066565b166001600160801b03198254161790556111b1565b906111a892509261125061119861125695612cb9565b90612fe6565b6001600160801b03166111b1565b808f91516112a6575b015161127a575b8e61107c565b6112a18260805160049160020b5f52016020525f6002604082208281558260018201550155565b611274565b6112cd8360805160049160020b5f52016020525f6002604082208281558260018201550155565b61126d565b632bbfae4960e21b5f5260045ffd5b61106061105a60409f9b6111219c6111339e6001600160801b0361130889600f0b83613066565b166001600160801b031984541617835561102f565b90999089136113435760028060018c0154600184015490039b015491015490039b610fb3565b9860026001608051015460018c01549003600183015490039a81806080510154910154900391015490039b610fb3565b6004608051018960020b5f5280602052898960405f206113c381546001600160801b036113a681831695600f0b86613066565b16931594858515141595611562575b508d600f0b9060801d612a13565b60801b82179055602087015285528760020b5f5260205260405f208054906001600160801b0382166113f88b600f0b82613066565b901592836001600160801b03831615141593611535575b8b600f0b9060801d600f0b039160016001607f1b03831360016001607f1b031984121761152157826001600160801b03935060801b83831617905516606086015260408501525f88600f0b12156114aa575b835161148e575b604084015115610f635761148960808c015160020b88600560805101612c6d565b610f63565b6114a560808c015160020b8a600560805101612c6d565b611468565b60808b015160020b6001600160801b03600181602088015116925f81620d89e719071281620d89e719050390620d89e805030181041680911161150e576001600160801b036060860151161115611461578663b8e3c38560e01b5f5260045260245ffd5b8963b8e3c38560e01b5f5260045260245ffd5b634e487b7160e01b5f52601160045260245ffd5b6080515460a01c60020b8b1361140f5760016080510154600184015560026080510154600284015561140f565b6080515460a01c60020b1215611579575b8e6113b5565b600160805101546001840155600260805101546002840155611573565b8563035aeeff60e31b5f5260045260245ffd5b8763d5e2f7ab60e01b5f5260045260245ffd5b604488876040519163c4433ed560e01b835260048301526024820152fd5b634e487b7160e01b5f52604160045260245ffd5b5f604085015113808091611696575b1561164457505060405163259982e560e01b602082015261163b91610d0d8261162d8887898c3360248701612590565b03601f198101845283612020565b505b8580610ead565b159081611688575b50611658575b5061163d565b60405163021d0ee760e41b602082015261168191610d0d8261162d8887898c3360248701612590565b5085611652565b61020091501615158761164c565b50610800821615156115fd565b346102e05760603660031901126102e0576116bc611f79565b6116c4611f8f565b6001600160a01b039182165f90815260056020908152604080832094909316825292835281812060443582528352819020549051908152f35b346102e05760403660031901126102e057611716611f79565b602435908115158092036102e057335f52600360205260405f2060018060a01b0382165f5260205260405f2060ff1981541660ff841617905560405191825260018060a01b0316907fceb576d9f15e4e200fdb5096d64d5dfd667e16def20c1eefd14256d8e3faa26760203392a3602060405160018152f35b346102e05760c03660031901126102e0576117a936612053565b6117b1612041565b906280000062ffffff6040830151161480159061181c575b61180d5760a0906117d98361256c565b205f52600660205260405f20906117ef82612494565b815462ffffff60d01b191660d09190911b62ffffff60d01b16179055005b6330d2164160e01b5f5260045ffd5b5060808101516001600160a01b03163314156117c9565b346102e05760203660031901126102e0576004356001600160401b0381116102e0576118639036906004016120da565b5f8051602061428a8339815191525c6119bb576118b0915f9160015f8051602061428a8339815191525d6040516348eeb9a360e11b815260206004820152938492839260248401916121ae565b038183335af19081156119b0575f91611928575b505f805160206142aa8339815191525c6119195760406020915f5f8051602061428a8339815191525d815192839181835280519182918282860152018484015e5f828201840152601f01601f19168101030190f35b635212cba160e01b5f5260045ffd5b90503d805f833e6119398183612020565b8101906020818303126102e0578051906001600160401b0382116102e0570181601f820112156102e0578051906001600160401b0382116115da576040519261198c601f8401601f191660200185612020565b828452602083830101116102e057815f9260208093018386015e83010152816118c4565b6040513d5f823e3d90fd5b6328486b6360e11b5f5260045ffd5b346102e0576119d836611fa5565b9091335f52600560205260405f2060018060a01b0382165f5260205260405f20835f526020528160405f205560405191825260018060a01b0316907fb3fd5071835887567a0671151121894ddccc2842f1d10bedad13e0d17cace9a760203392a4602060405160018152f35b60203660031901126102e057611a58611f79565b5f8051602061428a8339815191525c156103f8576106076020916123bd565b346102e05760403660031901126102e0576024356004356040519160408360208152826020820152019060051b8301916001602060408501935b8354815201910190848382101561077557506020600191611ab1565b346102e05760203660031901126102e057611ae6611f79565b611afa60018060a01b035f54163314612173565b600280546001600160a01b0319166001600160a01b039290921691821790557fb4bd8ef53df690b9943d3318996006dbb82a25f54719d8c8035b516a2a5b8acc5f80a2005b346102e0576101003660031901126102e057611b5a36612053565b60c4359060a43560e4356001600160401b0381116102e057611b809036906004016120da565b9190935f8051602061428a8339815191525c156103f857611b9f612453565b60a0842094855f52600660205260405f2094611bba86612494565b6080810180516001600160a01b0381169033829003611cf8575b50506001600160801b03600388015416978815611ce957602098611bf7876121ce565b5f03611c02876121ce565b5f036001600160801b03169060801b179887611cd5575b86611cc0575b5050611c2c338985612535565b60405190868252858a8301527f29ef05caaff9404b7cb6d1c0e9bbae9eaa7ab2541feba1a9c4248594c08156cb60403393a3516001600160a01b038116939033859003611c7e575b8888604051908152f35b601016611c8c575b80611c74565b611cb495610d0d9361162d9260405197889563e1b4af6960e01b8d88015233602488016124f7565b50828080808080611c86565b600201908660801b0481540190558980611c1f565b60018101828960801b048154019055611c19565b63a74f97ab60e01b5f5260045ffd5b602016611d06575b80611bd4565b604051635b54587d60e11b6020820152611d3091610d0d8261162d8b898b8d8b33602488016124f7565b5088611d00565b346102e05760203660031901126102e057600435545f5260205ff35b346102e057611d6136611fa5565b905f8051602061428a8339815191525c156103f8576001600160a01b0316915f905f8051602061426a8339815191529061037090611dae611da1866121ce565b8503600f0b3390886121ef565b60018060a01b0316938484526004602052604084208685526020526040842061022a828254612166565b5f3660031901126102e0575f8051602061428a8339815191525c156103f8576020610607336123bd565b346102e05760603660031901126102e057611e1b611f79565b611e23611f8f565b604435905f8051602061428a8339815191525c156103f857610a3292611e58611e4b846121ce565b5f03600f0b3390836121ef565b61227a565b346102e057611e6b36611fa5565b9091335f52600460205260405f20835f5260205260405f20611e8e838254612159565b905560018060a01b031690815f52600460205260405f20835f5260205260405f20611eba828254612166565b9055604080513380825260208201939093525f8051602061426a8339815191529181908101610244565b346102e05760203660031901126102e05760043563ffffffff60e01b81168091036102e0576020906301ffc9a760e01b8114908115611f29575b506040519015158152f35b630f632fb360e01b14905082611f1e565b346102e05760403660031901126102e0576020906001600160a01b03611f5e611f79565b165f526004825260405f206024355f52825260405f20548152f35b600435906001600160a01b03821682036102e057565b602435906001600160a01b03821682036102e057565b60609060031901126102e0576004356001600160a01b03811681036102e057906024359060443590565b608081019081106001600160401b038211176115da57604052565b606081019081106001600160401b038211176115da57604052565b60a081019081106001600160401b038211176115da57604052565b90601f801991011681019081106001600160401b038211176115da57604052565b60a4359062ffffff821682036102e057565b60a09060031901126102e0576040519061206c82612005565b816004356001600160a01b03811681036102e05781526024356001600160a01b03811681036102e057602082015260443562ffffff811681036102e05760408201526064358060020b81036102e0576060820152608435906001600160a01b03821682036102e05760800152565b9181601f840112156102e0578235916001600160401b0383116102e057602083818601950101116102e057565b9060206003198301126102e0576004356001600160401b0381116102e057826023820112156102e0578060040135926001600160401b0384116102e05760248460051b830101116102e0576024019190565b9190820391821161152157565b9190820180921161152157565b1561217a57565b60405162461bcd60e51b815260206004820152600c60248201526b15539055551213d49256915160a21b6044820152606490fd5b908060209392818452848401375f828201840152601f01601f1916010190565b6001607f1b8110156121e057600f0b90565b6393dafdf160e01b5f5260045ffd5b9190600f0b918215612275576001600160a01b039182165f90815291166020526040902061221f815c92836128b1565b80915d61224b57505f195f805160206142aa8339815191525c015f805160206142aa8339815191525d5b565b1561225257565b60015f805160206142aa8339815191525c015f805160206142aa8339815191525d565b505050565b9091906001600160a01b03811690816123085750505f80808093855af11561229f5750565b6040516390bfb86560e01b81526001600160a01b0390911660048201525f602482018190526080604483015260a03d601f01601f191690810160648401523d6084840152903d9060a484013e808201600460a482015260c4633d2cec6f60e21b91015260e40190fd5b60205f604481949682604095865198899363a9059cbb60e01b855260018060a01b0316600485015260248401525af13d15601f3d116001855114161716928281528260208201520152156123595750565b6040516390bfb86560e01b8152600481019190915263a9059cbb60e01b602482015260806044820152601f3d01601f191660a0810160648301523d60848301523d5f60a484013e808201600460a482015260c4633c9fd93960e21b91015260e40190fd5b5f8051602061424a8339815191525c91906001600160a01b0383166123f2576122499034935b6123ec856121ce565b906121ef565b34612444576122499061242e7f1e0745a7db1623981f0b2a5d4232364c00787266eb75ad546f190e6cebe9bd955c61242986612840565b612159565b935f5f8051602061424a8339815191525d6123e3565b635876424f60e11b5f5260045ffd5b7f00000000000000000000000000000000000000000000000000000000000000006001600160a01b0316300361248557565b6306c4a1c760e11b5f5260045ffd5b546001600160a01b0316156124a557565b63486aa30760e01b5f5260045ffd5b80516001600160a01b03908116835260208083015182169084015260408083015162ffffff169084015260608083015160020b9084015260809182015116910152565b919261251a6101209461253298969360018060a01b0316855260208501906124b4565b60c083015260e08201528161010082015201916121ae565b90565b9061224992916125538360018060a01b038351168460801d906121ef565b60200151600f9190910b906001600160a01b03166121ef565b62ffffff16620f4240811161257e5750565b631400211360e01b5f5260045260245ffd5b6001600160a01b0390911681526125329492610160926125e891906125b99060208501906124b4565b8051600290810b60c08501526020820151900b60e0840152604081015161010084015260600151610120830152565b8161014082015201916121ae565b9081600f0b9182036121e057565b9261265a9061262b6125329997946101a0979460018060a01b0316875260208701906124b4565b8051600290810b60c08701526020820151900b60e0860152604081015161010086015260600151610120850152565b6101408301526101608201528161018082015201916121ae565b939590919296945f9660018060a01b038616331461276757885f6040870151135f1461270f5761040087166126ad575b50505050505050565b61270297999850926126fb969594926126e1926126ef956040519788966327c18fbf60e21b60208901523360248901612604565b03601f198101835282612020565b6002821615159161308e565b80926130ae565b915f8080808080806126a4565b95949392919061010086166127275750505050505050565b612702979950869850916126e19161275b94936126fb98604051978896633615df3f60e11b60208901523360248901612604565b6001821615159161308e565b505f96505050505050565b608081161580612817575b6127ed5760408116158061280b575b6127ed57610400811615806127ff575b6127ed57610100811615806127f3575b6127ed576001600160a01b0381166127cd575062ffffff1662800000141590565b613fff1615908115916127de575090565b62800000915062ffffff161490565b50505f90565b506001811615156127ac565b5060028116151561279c565b5060048116151561278c565b5060088116151561277d565b6280000062ffffff82161461283b576125328161256c565b505f90565b6001600160a01b03168061285357504790565b6020602491604051928380926370a0823160e01b82523060048301525afa9081156119b0575f91612882575090565b90506020813d6020116128a9575b8161289d60209383612020565b810103126102e0575190565b3d9150612890565b9190915f838201938412911290801582169115161761152157565b6020830151955f958695919491336001600160a01b03851614612a0657608084166128f9575b5050505050565b612971926126e161296b92612957946040519586946315d7892d60e21b602087015233602487015261292e604487018c6124b4565b8051151560e48701526020810151610104870152604001516001600160a01b0316610124860152565b6101406101448501526101648401916121ae565b82612b5b565b9160608351036129f7576040015162ffffff1662800000146129eb575b60081661299f575b808080806128f2565b604001519250608083901d600f0b8015612996576129c0905f8612956128b1565b93156129e3575f84135b6129d4575f612996565b637d05b8eb60e11b5f5260045ffd5b5f84126129ca565b6060820151935061298e565b631e048e1d60e01b5f5260045ffd5b505f965086955050505050565b90600f0b90600f0b019060016001607f1b0319821260016001607f1b0383131761152157565b91969592949293336001600160a01b03841614612b4e578460801d94600f0b938860408516612ad9575b50505050505f9481600f0b15801590612acd575b612a83575b5050509190565b612ab19395505f60208201511290511515145f14612ab9576001600160801b03169060801b175b80936130ae565b5f8080612a7c565b906001600160801b03169060801b17612aaa565b5082600f0b1515612a77565b612b32612b3e946126e16111a895612b44999895612b1761292e9660405197889663b47b2fb160e01b602089015233602489015260448801906124b4565b8c6101448501526101606101648501526101848401916121ae565b6004821615159161308e565b90612a13565b5f80808088612a63565b5050505050909150905f90565b9190918251925f8060208301958682865af115612bc357505060405191601f19603f3d011683016040523d83523d9060208401915f833e6020845110918215612ba7575b50506129f757565b5190516001600160e01b03199182169116141590505f80612b9f565b5183516001600160e01b03198116919060048210612c4d575b50506040516390bfb86560e01b81526001600160a01b0390921660048301526001600160e01b03191660248201526080604482015260a03d601f01601f191690810160648301523d60848301523d5f60a484013e808201600460a482015260c463a9e35b2f60e01b91015260e40190fd5b6001600160e01b031960049290920360031b82901b161690508280612bdc565b919060020b9060020b90818107612c9b5705908160081d5f52602052600160ff60405f2092161b8154189055565b601c906044926040519163d4d8f3e683526020830152604082015201fd5b60020b908160ff1d82810118620d89e88111612fd35763ffffffff9192600182167001fffcb933bd6fad37aa2d162d1a59400102600160801b189160028116612fb7575b60048116612f9b575b60088116612f7f575b60108116612f63575b60208116612f47575b60408116612f2b575b60808116612f0f575b6101008116612ef3575b6102008116612ed7575b6104008116612ebb575b6108008116612e9f575b6110008116612e83575b6120008116612e67575b6140008116612e4b575b6180008116612e2f575b620100008116612e13575b620200008116612df8575b620400008116612ddd575b6208000016612dc4575b5f12612dbc575b0160201c90565b5f1904612db5565b6b048a170391f7dc42444e8fa290910260801c90612dae565b6d2216e584f5fa1ea926041bedfe9890920260801c91612da4565b916e5d6af8dedb81196699c329225ee6040260801c91612d99565b916f09aa508b5b7a84e1c677de54f3e99bc90260801c91612d8e565b916f31be135f97d08fd981231505542fcfa60260801c91612d83565b916f70d869a156d2a1b890bb3df62baf32f70260801c91612d79565b916fa9f746462d870fdf8a65dc1f90e061e50260801c91612d6f565b916fd097f3bdfd2022b8845ad8f792aa58250260801c91612d65565b916fe7159475a2c29b7443b29c7fa6e889d90260801c91612d5b565b916ff3392b0822b70005940c7a398e4b70f30260801c91612d51565b916ff987a7253ac413176f2b074cf7815e540260801c91612d47565b916ffcbe86c7900a88aedcffc83b479aa3a40260801c91612d3d565b916ffe5dee046a99a2a811c461f1969c30530260801c91612d33565b916fff2ea16466c96a3843ec78b326b528610260801c91612d2a565b916fff973b41fa98c081472e6896dfb254c00260801c91612d21565b916fffcb9843d60f6159c9db58835c9266440260801c91612d18565b916fffe5caca7e10e4e61c3624eaa0941cd00260801c91612d0f565b916ffff2e50f5f656932ef12357cf3c7fdcc0260801c91612d06565b916ffff97272373d413259a46990580e213a0260801c91612cfd565b826345c3193d60e11b5f5260045260245ffd5b905f83600f0b125f1461301257613008925f036001600160801b031691613fba565b5f81126121e05790565b613025926001600160801b031691613f7e565b5f81126121e0575f0390565b905f83600f0b125f1461305357613008925f036001600160801b031691614052565b613025926001600160801b031691613fe6565b906001600160801b0390600f0b911601908160801c61308157565b6393dafdf15f526004601cfd5b9061309891612b5b565b901561283b5760408151036129f7576040015190565b6130d1906130c38360801d8260801d036125f6565b92600f0b90600f0b036125f6565b6001600160801b03169060801b1790565b73fffd8963efd1fc6a506488495d951d51639616826401000276a21982016001600160a01b03161161332957602081901b640100000000600160c01b03168060ff61312c826140b0565b16916080831061331d5750607e1982011c5b800280607f1c8160ff1c1c800280607f1c8160ff1c1c800280607f1c8160ff1c1c800280607f1c8160ff1c1c800280607f1c8160ff1c1c800280607f1c8160ff1c1c80029081607f1c8260ff1c1c80029283607f1c8460ff1c1c80029485607f1c8660ff1c1c80029687607f1c8860ff1c1c80029889607f1c8a60ff1c1c80029a8b607f1c8c60ff1c1c80029c8d80607f1c9060ff1c1c800260cd1c6604000000000000169d60cc1c6608000000000000169c60cb1c6610000000000000169b60ca1c6620000000000000169a60c91c6640000000000000169960c81c6680000000000000169860c71c670100000000000000169760c61c670200000000000000169660c51c670400000000000000169560c41c670800000000000000169460c31c671000000000000000169360c21c672000000000000000169260c11c674000000000000000169160c01c6780000000000000001690607f190160401b1717171717171717171717171717693627a301d71055774c85026f028f6481ab7f045a5af012a19d003aa919810160801d60020b906fdb2df09e81959a81455e260799a0632f0160801d60020b918282145f146132f95750905090565b6001600160a01b039081169061330e84612cb9565b1611613318575090565b905090565b905081607f031b61313e565b6318521d4960e21b5f9081526001600160a01b0391909116600452602490fd5b8115613353570490565b634e487b7160e01b5f52601260045260245ffd5b6040519290915f61337785611fea565b5f855260208501925f845260408601955f875280968654956040860151159586155f14613d6857610fff8860b81c16945b81516001600160a01b038a1680875260a08b901c60020b90945260038b01546001600160801b031690945260808201515f94939062400000811615613d595762bfffff166133f58161256c565b61ffff8816613d3e575b8096620f424062ffffff83161015613d26575b845115613d1057505088613cc8576060830180519091906001600160a01b031681811015613caa575050516001600160a01b03166401000276a3811115613c9857505b604051986101008a018a81106001600160401b038211176115da576040525f8a525f60208b01525f60408b01525f60608b01525f60808b01525f60a08b01525f60c08b015288155f14613c8a5760018b0154949390945b60e08b01525b80158015613c6f575b613b845760018060a01b038c51168a528a60208d015160020b602085015160020b90815f818307129105038b155f14613a9157600560ff8216938260020b60081d60010b5f520160205260405f205f198460ff031c9054169283151593845f14613a7f579061352b60ff926140b0565b90031660020b900360020b0260020b5b905b151560408c015260020b8060208c0152620d89e7191215613a70575b620d89e860208b015160020b1215613a62575b858c8b8b6001600160801b0360406001808060a01b03613592602087015160020b612cb9565b16806060870152818060a01b0387511694828060a01b0360608d01511692839115168183101891180218940151169060018060a01b038416811015915f87125f1461393c5762ffffff8616620f4240036135ee81895f03613dbf565b95841561392b57613600838583613fe6565b965b87811061388857509660c093929188919062ffffff8216620f424003613874575050865b945b15613866579161363792613fba565b925b015260a08d015260808c01526001600160a01b03168c5282515f12156138365760a08a0151905f82126121e057039261367b60808b015160c08c015190612166565b5f81126121e057810390811360011661152157935b61ffff87166137ee575b6001600160801b0360408d015116806137d4575b508b5160608b01516001600160a01b03918216911681036137a5575060408a0151613705575b886136f8575f1960208b015160020b0160020b5b60020b60208d01525b93926134b2565b60208a015160020b6136e8565b88613782576001600160801b036137698d8d8d600460e08201519260206002820154935b015160020b60020b5f520160205260405f2091600183019081549003905560028201908154900390555460801d908c15613774575b604001518316613066565b1660408d01526136d4565b5f91909103600f0b9061375e565b6001600160801b036137698d8d8d6004600183015492602060e084015193613729565b8a516001600160a01b031681036137bd575b506136f1565b6137c6906130e2565b60020b60208d01525f6137b7565b60c08b015160801b0460e08b01510160e08b01525f6136ae565b9662ffffff861661ffff8816036138195760c08a0151905b8160c08c01510360c08c0152019661369a565b620f424060808b015161ffff89169060c08d015101020490613806565b60808a015160c08b015101905f82126121e057019260a08a01515f81126121e057613860916128b1565b93613690565b61386f92614052565b613637565b62ffffff613883921689614133565b613626565b97505050935091508392801583151761391e578e9260c09183156138bd576138b18782846141b6565b809789015f0394613628565b6001600160a01b038711613900576138fb6138f66138e76001600160801b0384168a60601b613349565b6001600160a01b038516612166565b614235565b6138b1565b6138fb6138f66139196001600160801b0384168a613e74565b6138e7565b634f2461b85f526004601cfd5b613936838286613f7e565b96613602565b91945091508315613a5157613952818385613fba565b925b83861061399e5780945b1561398f579161396d92613fe6565b905b8c60c061398962ffffff8c16620f42408190039086614133565b91613639565b61399892613f7e565b9061396f565b50849250811581151761391e578315613a41576001600160a01b038511613a09578460601b6001600160801b03821680820615159104015b6001600160a01b03831690808211156139fc5790036001600160a01b03165b809461395e565b634323a5555f526004601cfd5b6001600160801b038116613a2281600160601b88613efe565b90801561335357600160601b8709156139d657600101806139d6575f80fd5b613a4c85828461415c565b6139f5565b613a5c818484614052565b92613954565b620d89e860208b015261356c565b620d89e71960208b0152613559565b5060020b900360020b0260020b61353b565b6001018060020b9060058160ff16948360081d60010b5f520160205260405f2090600160ff5f1992161b0119905416801593841594855f14613b6c576102e0578160ff925f03167e1f0d1e100c1d070f090b19131c1706010e11080a1a141802121b1503160405601f6101e07f804040554300526644320000502061067405302602000010750620017611707760fc7fb6db6db6ddddddddd34d34d349249249210842108c6318c639ce739cffffffff860260f81c161b60f71c1692831c63d76453e004161a17031660020b0160020b0260020b5b9061353d565b5060ff809250031660020b0160020b0260020b613b66565b949891955099969298919598602088015160a01b62ffffff60a01b1660018060a01b038951169168ffffffffffffffffff60b81b16171782556001600160801b036003830154166001600160801b03604089015116809103613c4b575b508215613c3c5760e060029101519101555b825190155f821214613c265750613c0d613c1592936125f6565b9251036125f6565b6001600160801b03169060801b1793565b613c15925090613c3691036125f6565b916125f6565b60e06001910151910155613bf3565b6001600160801b03166001600160801b03196003840154161760038301555f613be1565b508b5160608401516001600160a01b039081169116146134bb565b60028b0154949390946134ac565b639e4d7cc760e01b5f5260045260245ffd5b6044925060405191637c9c6e8f60e01b835260048301526024820152fd5b6060830180519091906001600160a01b031681811115613caa575050516001600160a01b031673fffd8963efd1fc6a506488495d951d5263988d26811015613c985750613455565b9a509a50509950505050505050505f925f929190565b5f8551131561341257634b10312360e11b5f5260045ffd5b62ffffff610fff89169116620f4240818302049101036133ff565b508960d01c62ffffff166133f5565b610fff8860c41c16946133a8565b81810291905f1982820991838084109303928084039384600160801b11156102e05714613db657600160801b910990828211900360801b910360801c1790565b50505060801c90565b808202905f1983820990828083109203918083039283620f424011156102e05714613e1f577fde8f6cefed634549b62c77574f722e1ac57e23f24d8fd5cb790fb65668c2613993620f4240910990828211900360fa1b910360061c170290565b5050620f424091500490565b81810291905f1982820991838084109303928084039384600160601b11156102e05714613e6b57600160601b910990828211900360a01b910360601c1790565b50505060601c90565b90606082901b905f19600160601b8409928280851094039380850394858411156102e05714613ef7578190600160601b900981805f03168092046002816003021880820260020302808202600203028082026002030280820260020302808202600203028091026002030293600183805f03040190848311900302920304170290565b5091500490565b91818302915f19818509938380861095039480860395868511156102e05714613f76579082910981805f03168092046002816003021880820260020302808202600203028082026002030280820260020302808202600203028091026002030293600183805f03040190848311900302920304170290565b505091500490565b6001600160a01b0391821691160360ff81901d90810118906001906001600160801b0316613fac8382613e2b565b928260601b91091515160190565b612532926001600160a01b03928316919092160360ff81901d90810118906001600160801b0316613e2b565b6001600160a01b038281169082161161404c575b6001600160a01b03811692831561404057614034926001600160a01b0380821693909103169060601b600160601b600160e01b0316614133565b90808206151591040190565b62bfc9215f526004601cfd5b90613ffa565b906001600160a01b03808216908316116140aa575b6001600160a01b03821691821561404057612532936140a5926001600160a01b0380821693909103169060601b600160601b600160e01b0316613efe565b613349565b90614067565b80156102e0577f07060605060205000602030205040001060502050303040105050304000000006f8421084210842108cc6318c6db6d54be826001600160801b031060071b83811c6001600160401b031060061b1783811c63ffffffff1060051b1783811c61ffff1060041b1783811c60ff1060031b1792831c1c601f161a1790565b929190614141828286613efe565b938215613353570961414f57565b906001019081156102e057565b919081156141b1576001600160a01b03909216918183029160609190911b600160601b600160e01b0316908204831482821116156141a457612532926138f692820391614133565b63f5c787f15f526004601cfd5b505090565b919081156141b15760601b600160601b600160e01b0316916001600160a01b031690808202826141e68383613349565b14614213575b506141fa6141ff9284613349565b612166565b80820491061515016001600160a01b031690565b83018381106141ec576001600160a01b039361423193919250614133565b1690565b6001600160a01b038116919082036121e05756fe27e098c505d44ec3574004bca052aabf76bd35004c182099d8c575fb238593b91b3d7edb2e9c0b0e7c525b20aaaef0f5940d2ed71663c7d39266ecafac728859c090fc4683624cfc3884e9d8de5eca132f2d0ec062aff75d43c0465d5ceeab237d4b3164c6e45b97e7d87b7125a44c5828d005af88f9d751cfd78729c5d99a0ba2646970667358221220ba3eba4f7f3e0b89d8b35bad0e948224cdfe28eddaad072738bd4db6e039c0ef64736f6c634300081a0033";
}
