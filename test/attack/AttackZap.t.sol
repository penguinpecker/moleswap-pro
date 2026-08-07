// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/*//////////////////////////////////////////////////////////////////////////////
                                   F I N D I N G S

  Target:  src/MolePositions.sol :: zapOpen / _zap  (the one-token deposit)
  Lens:    "this function settles, swaps, mints and pays out inside ONE unlock. Which of
            those four steps can be made to leave value somewhere it does not belong?"

  ---------------------------------------------------------------------------
  Z-1. **REAL CONTRACT BUG, FOUND BY THIS FILE, FIXED IN src/ WHILE IT WAS BEING WRITTEN.**
       The test below is now the REGRESSION test for that fix, and it is mutation-verified by
       the accident of history described at the bottom of this entry.

       WHAT WAS WRONG. `maxPositionLiquidity` — the deposit cap — was not enforced on a zap.
       zapOpen checked the size band against `z.minLiquidity`, the caller's own SLIPPAGE
       FLOOR, and never against the liquidity actually minted:

           if (maxPositionLiquidity != 0 && z.minLiquidity > maxPositionLiquidity) revert PositionTooLarge();

       `minLiquidity` is a lower bound the caller picks freely. Declare a floor inside the
       band and the check is satisfied for any cap; the size that actually gets minted is
       decided by `amountIn`, which has no ceiling anywhere on this path. MEASURED, not
       argued: with the band set to [1e18, 10e18], `open()` correctly refused 200e18 with
       PositionTooLarge, and the same vault in the same transaction accepted a ZAP of 100e18
       that minted MORE THAN TEN TIMES the cap, under a floor of 1e18.

       WHY IT MATTERED AND WHY IT WAS NOT COSMETIC. The contract states the cap's job in its
       own words: "its real job is stopping THIS VAULT from becoming the pool's dominant LP,
       which is the condition that made the oracle cheap to walk in F-4." So the bypassed
       bound was the one standing between this deployment and the F-4 oracle-manipulation
       precondition, and the bypass was available to any depositor, permissionlessly, in one
       call.

       THE FLOOR HALF WAS ALWAYS FINE, and the test still pins it: `minted >= minLiquidity`
       is enforced after the unlock, so `minPositionLiquidity` bound transitively even before
       the fix. Only the CEILING was bypassable. Both halves are asserted below, because a
       fix that closed the ceiling by breaking the floor would be a different bug.

       THE FIX, now in zapOpen right after the `minted < z.minLiquidity` check: re-check BOTH
       ends of the band against `minted` rather than against the caller's declared floor.

       MUTATION-VERIFIED, AND NOT BY DESIGN. This test was written against the unfixed
       contract and asserted the bypass; it PASSED, measuring >10x the cap. The fix then
       landed in src/ mid-session and the identical call flipped to reverting
       PositionTooLarge — the test went RED at exactly the line the guard governs. So the
       `vm.expectRevert(PositionTooLarge)` below has been empirically shown to fail when the
       guard is absent and pass when it is present, which is the whole standard: a guard that
       has never been observed failing is a guard nobody has tested.

  ---------------------------------------------------------------------------
  Everything else attacked here HOLDS:

  Z-2. CUSTODY / INV-1. After a zap the vault holds zero token0, zero token1, AND zero
       ERC-6909 claims against the PoolManager for either currency. The claims half is the
       half a token-balance-only assertion misses: a claim is a balance inside the
       PoolManager that no ERC-20 balanceOf can see, and it is exactly the shape the shared
       pot would take if it came back in v4-native form. Asserted after the zap, after a
       swap, and after the exit. Also asserted with a performance fee configured, where the
       vault is the one contract that is forbidden from being the fee recipient.

  Z-3. THE RESIDUAL GOES TO THE OWNER. Proven with tx.origin DIFFERENT from msg.sender
       (vm.prank(alice, mallory)), so "the payout follows msg.sender" is falsifiable rather
       than incidental: mallory, the keeper, the test contract and the vault all end the
       transaction with exactly what they started with, and alice is paid ~60e18 of a 100e18
       deposit straight back.

  Z-4. SLIPPAGE. `minLiquidity` binds: an absurd floor reverts ExceedsMaxAmount and — the
       part that matters more — the reverted zap leaves NOTHING behind. positionCount is
       still 0, no Position exists, and the depositor's balances are untouched to the wei,
       even though zapOpen increments positionCount and writes storage BEFORE the unlock.

  Z-5. NO FREE MONEY, FUZZED over amount, split and direction: zap in, withdraw everything,
       and the sum of both tokens returned is <= amountIn (+2 wei). It is also >= 97% of it,
       so the bound is not satisfied by a contract that simply eats the deposit.

  Z-6. OWNERSHIP. getPosition(id).owner is the zapper; no other user, and not the keeper,
       can withdraw it (NotOwner).

  Z-7. INPUT VALIDATION. swapAmount == amountIn, swapAmount > amountIn, amountIn == 0,
       minLiquidity == 0 -> ZeroLiquidity. Un-whitelisted pool -> PoolNotWhitelisted.
       Expired deadline -> DeadlinePassed. Each with the SPECIFIC selector.

  Z-8. ONE-SIDED RANGES. A range entirely ABOVE spot and a range entirely BELOW spot both
       mint coherently: the leg the range cannot use is returned to the owner in full as
       residual, the position is real, and it is fully withdrawable. Neither mints something
       that cannot be exited.

  Z-9. THE PULL IS BOUNDED BY amountIn. Proven with an allowance of EXACTLY amountIn rather
       than the usual type(uint256).max: the zap succeeds and the remaining allowance is 0,
       so `_settleFrom(cIn, z.amountIn, owner)` is the only pull and the mint cannot reach
       back into the depositor for a wei of rounding.

  ---------------------------------------------------------------------------
  RESIDUAL, REPORTED NOT SUPPRESSED (not exploited here):

  * The zap's swap runs with NO price limit (MIN_SQRT_PRICE+1 / MAX_SQRT_PRICE-1). The
    contract argues, correctly, that `minLiquidity` is the real bound because it binds on the
    outcome. That is true for the SWAP, but note what it does not bound: the position's
    RANGE is fixed by the caller before the price moves, so a sandwicher who displaces spot
    can still push a would-be two-sided deposit to one side of its own range and collect the
    difference as residual. The user keeps every token (custody holds, Z-5 holds); what they
    lose is the position they asked for. Bounding that needs a sqrtPriceLimit or a
    post-swap tick check, neither of which exists.

  * `ExceedsMaxAmount()` is the selector for "minted less than you asked for". The name says
    the opposite of what the condition tests. Cosmetic, but it will mislead an integrator
    decoding a revert.
//////////////////////////////////////////////////////////////////////////////*/

import {Deployers} from "@uniswap/v4-core/test/utils/Deployers.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/types/PoolId.sol";
import {Currency, CurrencyLibrary} from "v4-core/types/Currency.sol";
import {ModifyLiquidityParams} from "v4-core/types/PoolOperation.sol";
import {StateLibrary} from "v4-core/libraries/StateLibrary.sol";

import {LiquidityAmounts} from "v4-periphery/libraries/LiquidityAmounts.sol";
import {TickMath} from "v4-core/libraries/TickMath.sol";
import {MolePositions} from "../../src/MolePositions.sol";
import {ZapLogic} from "../../src/libraries/ZapLogic.sol";
import {deployMoleVault, TEST_UPGRADE_ADMIN} from "../helpers/ProxyDeploy.sol";

contract AttackZap is Deployers {
    using PoolIdLibrary for PoolKey;
    using CurrencyLibrary for Currency;
    using StateLibrary for IPoolManager;

    MolePositions internal mole;

    address internal KEEPER = makeAddr("keeper");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal mallory = makeAddr("mallory");
    address internal carol = makeAddr("carol");
    address internal FEE_SINK = makeAddr("feeSink");

    MockERC20 internal t0;
    MockERC20 internal t1;

    uint32 internal constant INTERVAL = 1 hours;
    int24 internal constant MIN_W = 120;
    int24 internal constant MAX_W = 60_000;
    int24 internal constant SPACING = 60;

    /// @dev The default zap range: symmetric around the 1:1 start price, so a two-sided mint is
    ///      genuinely possible and a one-sided outcome is a finding rather than the setup.
    int24 internal constant LO = -6000;
    int24 internal constant HI = 6000;

    /// @dev Local mirror of MolePositions' event, so vm.expectEmit can match it. Solidity will not
    ///      let a test emit another contract's event; a byte-identical local declaration is the
    ///      standard way, and it is checked against `address(mole)` as the emitter.
    event ZapResidualPaid(uint256 indexed positionId, address indexed owner, uint256 amount0, uint256 amount1);

    function setUp() public {
        deployFreshManagerAndRouters();
        (currency0, currency1) = deployMintAndApprove2Currencies();
        (key,) = initPool(currency0, currency1, IHooks(address(0)), 3000, SPACING, SQRT_PRICE_1_1);

        t0 = MockERC20(Currency.unwrap(currency0));
        t1 = MockERC20(Currency.unwrap(currency1));

        // DEEP background liquidity. Without something to trade against, the swap inside the zap
        // would move spot so far that every assertion below would be measuring price impact rather
        // than the contract's behaviour.
        modifyLiquidityRouter.modifyLiquidity(
            key,
            ModifyLiquidityParams({tickLower: -60_000, tickUpper: 60_000, liquidityDelta: 20_000e18, salt: 0}),
            ZERO_BYTES
        );

        mole = deployMoleVault(manager, KEEPER, INTERVAL, MIN_W, MAX_W, address(0), 0, 0, 0, 0, 10_000, 0, 0, address(0));
        mole.whitelistPool(key);

        _fund(alice);
        _fund(bob);
        _fund(mallory);
        _fund(carol);
        _fund(KEEPER);
    }

    /* ---------------------------------------------------------------- helpers */

    function _fund(address who) internal {
        t0.transfer(who, 1_000e18);
        t1.transfer(who, 1_000e18);
        vm.startPrank(who);
        t0.approve(address(mole), type(uint256).max);
        t1.approve(address(mole), type(uint256).max);
        vm.stopPrank();
    }

    function _bal(address who) internal view returns (uint256, uint256) {
        return (t0.balanceOf(who), t1.balanceOf(who));
    }

    function _zp(int24 lo, int24 hi, bool zeroForOne, uint256 amountIn, uint256 swapAmount, uint128 minLiq)
        internal
        view
        returns (ZapLogic.ZapParams memory)
    {
        return _zpKey(key, lo, hi, zeroForOne, amountIn, swapAmount, minLiq);
    }

    /// @dev 8-argument form, carrying the swap-output floor.
    function _zp(
        int24 lo,
        int24 hi,
        bool zeroForOne,
        uint256 amountIn,
        uint256 swapAmount,
        uint128 minLiq,
        uint256 amountOutMin
    ) internal view returns (ZapLogic.ZapParams memory z) {
        z = _zp(lo, hi, zeroForOne, amountIn, swapAmount, minLiq);
        z.amountOutMin = amountOutMin;
    }

    function _zpKey(
        PoolKey memory k,
        int24 lo,
        int24 hi,
        bool zeroForOne,
        uint256 amountIn,
        uint256 swapAmount,
        uint128 minLiq
    ) internal pure returns (ZapLogic.ZapParams memory) {
        return ZapLogic.ZapParams({
            key: k,
            tickLower: lo,
            tickUpper: hi,
            zeroForOne: zeroForOne,
            amountIn: amountIn,
            swapAmount: swapAmount,
            minLiquidity: minLiq,
            // 0 = no swap-output floor, which is what every pre-existing test in this file assumed.
            // The dedicated Z-A tests below pass a real one.
            amountOutMin: 0
        });
    }

    /// @notice Z-A REGRESSION. `minLiquidity` alone is NOT a slippage bound on a one-sided range, and
    ///         this is the test that pins the fix.
    ///
    ///         THE HOLE: when the post-swap price sits at or below `tickLower`,
    ///         LiquidityAmounts.getLiquidityForAmounts takes its FIRST branch and derives liquidity from
    ///         `amount0` ALONE — the swap output is discarded entirely. On that path `minted` is a closed
    ///         form over amountIn, swapAmount and the two ticks, every one of them caller-chosen. So
    ///         `minted >= minLiquidity` compared a constant against itself and passed no matter how badly
    ///         the swap executed. A depositor could lose the whole swapped leg with no guard firing,
    ///         because the loss lands inside the swap, before any custody accounting.
    ///
    ///         THE FIX is `amountOutMin`, which binds the SWAP rather than the mint.
    function test_attack_Z_A_minLiquidityAloneCannotProtectAOneSidedZap() public {
        // A range entirely ABOVE spot with zeroForOne: selling token0 only pushes price further down,
        // so branch 1 holds unconditionally and `minted` cannot depend on execution.
        int24 lo = 1200;
        int24 hi = 6000;

        // The honest liquidity for the UNSWAPPED leg — computable off-chain by anyone, and provably
        // independent of the swap.
        uint128 honest = LiquidityAmounts.getLiquidityForAmount0(
            TickMath.getSqrtPriceAtTick(lo), TickMath.getSqrtPriceAtTick(hi), 1e18
        );

        // PROOF THE HOLE WAS REAL: with amountOutMin = 0 the zap still succeeds while swapping 99% of
        // the deposit, and mints EXACTLY the constant — so a tight-looking `minLiquidity` set to that
        // very number would have passed regardless of what the swap returned.
        vm.prank(alice);
        uint256 id = mole.zapOpen(_zp(lo, hi, true, 100e18, 99e18, honest, 0), block.timestamp);
        assertEq(
            mole.getPosition(id).liquidity,
            honest,
            "minted is NOT the swap-independent constant -- the premise of Z-A no longer holds"
        );

        // AND THE FIX BINDS. The floor is set ABOVE what the swap can possibly return — a 99e18 exact-input
        // sale cannot yield 198e18, at any price, in any pool — so this is unachievable by construction
        // rather than by a guess about this particular pool's depth.
        vm.prank(alice);
        vm.expectRevert(ZapLogic.SwapOutputBelowMinimum.selector);
        mole.zapOpen(_zp(lo, hi, true, 100e18, 99e18, honest, 198e18), block.timestamp);

        // ...and a floor the swap genuinely clears still goes through, so it is a bound and not a ban.
        vm.prank(alice);
        uint256 ok = mole.zapOpen(_zp(lo, hi, true, 100e18, 99e18, honest, 1e15), block.timestamp);
        assertGt(mole.getPosition(ok).liquidity, 0, "an achievable output floor was refused");
    }

    /// @dev INV-1, BOTH HALVES. The ERC-20 half is the classic shared-pot check. The ERC-6909 half
    ///      is the one a balanceOf-only assertion cannot see: `poolManager.mint` credits a balance
    ///      INSIDE the PoolManager that never touches the token contract, so a vault that minted
    ///      claims to itself would read as zero on every ERC-20 lens while holding real value.
    ///      That is exactly the shape the 2026-08-01 pot would take if it came back v4-native, and
    ///      it is why `feeRecipient == address(this)` is refused at initialization.
    function _assertNoCustody(MolePositions m, string memory whenWhat) internal view {
        assertEq(t0.balanceOf(address(m)), 0, string.concat("INV-1 BROKEN (token0 balance): ", whenWhat));
        assertEq(t1.balanceOf(address(m)), 0, string.concat("INV-1 BROKEN (token1 balance): ", whenWhat));
        assertEq(
            manager.balanceOf(address(m), currency0.toId()), 0, string.concat("INV-1 BROKEN (6909 claim 0): ", whenWhat)
        );
        assertEq(
            manager.balanceOf(address(m), currency1.toId()), 0, string.concat("INV-1 BROKEN (6909 claim 1): ", whenWhat)
        );
    }

    function _assertNoCustody(string memory whenWhat) internal view {
        _assertNoCustody(mole, whenWhat);
    }

    function _withdrawAll(address who, uint256 id) internal returns (uint128 removed) {
        removed = mole.getPosition(id).liquidity;
        vm.prank(who);
        mole.withdrawAll(id);
        assertEq(mole.getPosition(id).liquidity, 0, "position not fully closed");
    }

    /* ============================================================ Z-2 CUSTODY */

    /// @notice THE WHOLE PRODUCT, ON THE NEW PATH. A zap settles a user's tokens, swaps, mints and
    ///         pays a residual inside one unlock — four opportunities to leave value behind. After
    ///         each of them the vault must hold nothing at all: no token0, no token1, and no
    ///         ERC-6909 claim against the PoolManager for either currency.
    function test_attack_zapLeavesNoTokenBalanceAndNoERC6909ClaimsInTheVault() public {
        _assertNoCustody("before anything happens");

        vm.prank(alice);
        uint256 id = mole.zapOpen(_zp(LO, HI, true, 100e18, 40e18, 1), block.timestamp);

        _assertNoCustody("immediately after the zap");
        assertGt(mole.getPosition(id).liquidity, 0, "zap minted nothing - test would be vacuous");

        // NON-VACUITY CONTROL 1. Custody exists — it is just not the vault's. If the PoolManager held
        // nothing either, the assertions above would pass on a contract that did nothing at all.
        assertGt(t0.balanceOf(address(manager)), 0, "PoolManager holds no token0 - the world is empty");
        assertGt(t1.balanceOf(address(manager)), 0, "PoolManager holds no token1 - the world is empty");

        // NON-VACUITY CONTROL 2, and this one matters: prove the ERC-6909 LENS ITSELF can see a
        // claim. `manager.balanceOf(who, currency.toId())` returning zero is only evidence if the
        // same expression returns non-zero when a claim really exists — otherwise a wrong currency
        // id, or a lens that never resolves, would read as "no claims" forever. So mint a real claim
        // to a probe address and require the identical expression to report it.
        claimsRouter.deposit(currency0, address(this), 3e18);
        assertEq(manager.balanceOf(address(this), currency0.toId()), 3e18, "the ERC-6909 lens is blind");
        _assertNoCustody("while a third party demonstrably holds a claim");
        // The probe claim is deliberately NOT unwound. Burning it back panicked on an underflow inside
        // PoolClaimsTest, and unwinding it proves nothing anyway: the claim belongs to this TEST contract,
        // never to the vault, so every `_assertNoCustody` below is unaffected by its continued existence.
        // What the probe had to establish — that `manager.balanceOf(who, currency.toId())` can see a real
        // claim, so a zero reading is evidence rather than a blind lens — is already established above.

        // Trade across the position so it accrues real fees, then look again: fees realize on the
        // NEXT liquidity change, and a vault that banked them would show up here.
        swap(key, true, -50e18, ZERO_BYTES);
        swap(key, false, -50e18, ZERO_BYTES);
        _assertNoCustody("after real trading over the zapped position");

        _withdrawAll(alice, id);
        _assertNoCustody("after the zapper exited in full");
    }

    /// @notice A zap is a DEPOSIT, and a deposit realizes nothing — so even a vault configured with
    ///         the maximum performance fee must mint no claims to anybody on this path, least of all
    ///         to itself. The vault is the one address forbidden from being the fee recipient, and
    ///         this pins that the zap cannot route around that refusal.
    function test_attack_zapIsNotADepositFeePathAndMintsNoClaimsToAnyone() public {
        MolePositions feeVault =
            deployMoleVault(manager, KEEPER, INTERVAL, MIN_W, MAX_W, address(0), 0, 0, 0, 0, 10_000, 0, 2000, FEE_SINK);
        feeVault.whitelistPool(key);
        assertEq(feeVault.performanceFeeBps(), 2000, "fee not configured - test would be vacuous");

        vm.startPrank(alice);
        t0.approve(address(feeVault), type(uint256).max);
        t1.approve(address(feeVault), type(uint256).max);
        uint256 id = feeVault.zapOpen(_zp(LO, HI, true, 100e18, 40e18, 1), block.timestamp);
        vm.stopPrank();

        assertGt(feeVault.getPosition(id).liquidity, 0, "zap minted nothing - test would be vacuous");
        _assertNoCustody(feeVault, "after a zap into a fee-charging vault");

        // Nobody was paid a deposit fee: not the sink, not the vault, not in tokens, not in claims.
        assertEq(manager.balanceOf(FEE_SINK, currency0.toId()), 0, "deposit was taxed (claim 0)");
        assertEq(manager.balanceOf(FEE_SINK, currency1.toId()), 0, "deposit was taxed (claim 1)");
        assertEq(t0.balanceOf(FEE_SINK), 0, "deposit was taxed (token0)");
        assertEq(t1.balanceOf(FEE_SINK), 0, "deposit was taxed (token1)");
    }

    /* =========================================================== Z-3 RESIDUAL */

    /// @notice THE RESIDUAL BELONGS TO THE DEPOSITOR. Swapping only 20% of a 100e18 deposit into a
    ///         symmetric range leaves ~60e18 of token0 that the mint cannot use — not dust, most of
    ///         the deposit — and every wei of it must land on the address that called zapOpen.
    ///
    ///         tx.origin is DELIBERATELY a different address (mallory) from msg.sender (alice). That
    ///         is what makes "the payout follows msg.sender" falsifiable: a contract that paid
    ///         tx.origin, or the tx submitter, or itself, passes a same-address test and fails this.
    function test_attack_zapResidualIsPaidToThePrankedOwnerAndToNobodyElse() public {
        (uint256 a0, uint256 a1) = _bal(alice);
        (uint256 m0, uint256 m1) = _bal(mallory);
        (uint256 k0, uint256 k1) = _bal(KEEPER);
        (uint256 self0, uint256 self1) = _bal(address(this));

        // Topic check only: the id and the OWNER. The amounts are read from balances below, which is
        // stronger evidence than an event the contract also authors.
        vm.expectEmit(true, true, false, false, address(mole));
        emit ZapResidualPaid(1, alice, 0, 0);

        vm.prank(alice, mallory); // msg.sender = alice, tx.origin = mallory
        uint256 id = mole.zapOpen(_zp(LO, HI, true, 100e18, 20e18, 1), block.timestamp);

        assertEq(id, 1, "unexpected position id");
        assertEq(mole.getPosition(id).owner, alice, "owner is not the caller");
        _assertNoCustody("after a zap with a large residual");

        // Alice paid 100e18 of token0 and got a large slice of it straight back, so her NET spend is
        // far below what she handed over. A residual kept by the vault, or paid to anyone else,
        // would show up here as a net spend of the full 100e18.
        (uint256 a0End, uint256 a1End) = _bal(alice);
        uint256 netSpend0 = a0 - a0End;
        assertLt(netSpend0, 60e18, "the residual did NOT come back to the depositor");
        assertGt(netSpend0, 0, "nothing was deposited - test would be vacuous");
        assertGe(100e18 - netSpend0, 50e18, "residual smaller than expected - test would be weak");
        assertEq(a1End, a1, "depositor's token1 moved on a token0-in zap");

        // And nobody else received a thing. tx.origin first, because that is the one an
        // implementation could plausibly have used by accident.
        (uint256 m0End, uint256 m1End) = _bal(mallory);
        assertEq(m0End, m0, "tx.origin RECEIVED token0");
        assertEq(m1End, m1, "tx.origin RECEIVED token1");
        (uint256 k0End, uint256 k1End) = _bal(KEEPER);
        assertEq(k0End, k0, "keeper RECEIVED token0");
        assertEq(k1End, k1, "keeper RECEIVED token1");
        (uint256 s0End, uint256 s1End) = _bal(address(this));
        assertEq(s0End, self0, "the tx submitter RECEIVED token0");
        assertEq(s1End, self1, "the tx submitter RECEIVED token1");

        emit log_named_decimal_uint("deposited token0      ", 100e18, 18);
        emit log_named_decimal_uint("net spend after residual", netSpend0, 18);
    }

    /* =========================================================== Z-4 SLIPPAGE */

    /// @notice `minLiquidity` is the ONLY slippage bound the zap has — the swap runs with no price
    ///         limit — so if it does not bind, the deposit path is unbounded. Set it absurdly high
    ///         and require the exact selector.
    ///
    ///         The second half is the part that is easy to get wrong: zapOpen increments
    ///         positionCount, writes a Position and pushes to the owner's index BEFORE it opens the
    ///         unlock, and the slippage check happens AFTER the unlock returns. A failed zap must
    ///         therefore unwind all of that — no ghost position, no id burned, not a wei moved.
    function test_attack_zapMinLiquidityIsARealSlippageBoundAndAFailedZapCreatesNothing() public {
        (uint256 a0, uint256 a1) = _bal(alice);

        vm.prank(alice);
        vm.expectRevert(MolePositions.MintedBelowMinimum.selector);
        mole.zapOpen(_zp(LO, HI, true, 100e18, 40e18, type(uint128).max), block.timestamp);

        // A floor just above what the pool can actually deliver must fail too, so the guard is a
        // real comparison and not just an overflow artefact of type(uint128).max.
        vm.prank(alice);
        vm.expectRevert(MolePositions.MintedBelowMinimum.selector);
        mole.zapOpen(_zp(LO, HI, true, 100e18, 40e18, 100_000e18), block.timestamp);

        (uint256 a0End, uint256 a1End) = _bal(alice);
        assertEq(a0End, a0, "depositor paid for a reverted zap (token0)");
        assertEq(a1End, a1, "depositor paid for a reverted zap (token1)");
        assertEq(mole.positionCount(), 0, "a reverted zap left a position id behind");
        assertEq(mole.getPosition(1).owner, address(0), "a reverted zap left a Position in storage");
        assertEq(mole.positionsOf(alice).length, 0, "a reverted zap left an entry in the owner index");
        _assertNoCustody("after two reverted zaps");

        // POSITIVE CONTROL: the same zap with an honest floor succeeds, so the reverts above are the
        // bound biting and not the zap being broken for every input.
        vm.prank(alice);
        uint256 id = mole.zapOpen(_zp(LO, HI, true, 100e18, 40e18, 100e18), block.timestamp);
        assertGe(mole.getPosition(id).liquidity, 100e18, "minted less than the floor that was accepted");
        _assertNoCustody("after the positive control zap");
    }

    /* ======================================================= Z-5 NO FREE MONEY */

    /// @notice THE ECONOMIC INVARIANT. A depositor puts in `amountIn` of ONE token and can never get
    ///         more back out than they put in, counting BOTH tokens, across the whole round trip:
    ///         zap in, take the residual, withdraw everything.
    ///
    ///         Summing two different tokens is only legitimate because the pool starts at exactly
    ///         1:1 and the swap always moves the price AGAINST the swapper, so the sum is a strict
    ///         upper bound on value received. The lower bound (>= 97%) is what stops the assertion
    ///         being satisfiable by a contract that simply confiscates the deposit.
    function testFuzz_attack_zapThenWithdrawAllCannotReturnMoreThanWasDeposited(
        uint256 amountIn,
        uint16 swapBps,
        bool zeroForOne
    ) public {
        amountIn = bound(amountIn, 1e15, 200e18);
        swapBps = uint16(bound(swapBps, 100, 9000)); // swap 1%..90% of the deposit
        uint256 swapAmount = (amountIn * swapBps) / 10_000;
        assertGt(swapAmount, 0, "degenerate fuzz case");
        assertLt(swapAmount, amountIn, "degenerate fuzz case");

        MockERC20 tIn = zeroForOne ? t0 : t1;
        MockERC20 tOut = zeroForOne ? t1 : t0;

        uint256 inBefore = tIn.balanceOf(alice);
        uint256 outBefore = tOut.balanceOf(alice);

        vm.prank(alice);
        uint256 id = mole.zapOpen(_zp(LO, HI, zeroForOne, amountIn, swapAmount, 1), block.timestamp);
        _assertNoCustody("after a fuzzed zap");

        _withdrawAll(alice, id);
        _assertNoCustody("after a fuzzed zap was fully exited");

        // Alice's ONLY outflow is amountIn of the input token, so everything she is holding above
        // (start - amountIn) is what came back to her.
        uint256 returnedIn = tIn.balanceOf(alice) + amountIn - inBefore;
        uint256 returnedOut = tOut.balanceOf(alice) - outBefore;
        uint256 returned = returnedIn + returnedOut;

        // THE ATTACK: mint value out of a round trip. Two wei of Uniswap rounding, no more.
        assertLe(returned, amountIn + 2, "FREE MONEY: a zap round trip returned more than it consumed");

        // And the inverse failure: the deposit is not eaten. Worst case here is ~1% (0.3% LP fee on
        // up to 90% of the deposit, plus price impact on a 20_000e18 pool).
        assertGe(returned, (amountIn * 9700) / 10_000, "a zap round trip lost more than trading costs");
    }

    /* =========================================================== Z-6 OWNERSHIP */

    /// @notice The zapped position is the ZAPPER'S. Nobody else can take it out — not another
    ///         depositor, not the keeper, not the upgrade admin through the ordinary surface.
    function test_attack_zappedPositionBelongsToTheZapperAndNoOtherUserCanWithdrawIt() public {
        vm.prank(alice);
        uint256 id = mole.zapOpen(_zp(LO, HI, true, 100e18, 40e18, 1), block.timestamp);

        assertEq(mole.getPosition(id).owner, alice, "zapped position is not the zapper's");
        assertEq(mole.ownerOf(id), alice, "ownerOf disagrees with getPosition");
        assertEq(mole.positionsOf(alice).length, 1, "owner index missed the zap");
        assertEq(mole.positionsOf(alice)[0], id, "owner index holds the wrong id");
        assertEq(mole.positionsOf(bob).length, 0, "a non-owner was indexed for the position");

        uint128 liq = mole.getPosition(id).liquidity;

        address[4] memory strangers = [bob, mallory, KEEPER, TEST_UPGRADE_ADMIN];
        for (uint256 i = 0; i < strangers.length; i++) {
            vm.prank(strangers[i]);
            vm.expectRevert(MolePositions.NotOwner.selector);
            mole.withdraw(id, liq);

            vm.prank(strangers[i]);
            vm.expectRevert(MolePositions.NotOwner.selector);
            mole.withdrawAll(id);
        }

        assertEq(mole.getPosition(id).liquidity, liq, "liquidity moved on a refused withdrawal");
        _assertNoCustody("after four strangers tried to withdraw a zapped position");

        // The owner, and only the owner, can actually take it out.
        (uint256 a0, uint256 a1) = _bal(alice);
        _withdrawAll(alice, id);
        (uint256 a0End, uint256 a1End) = _bal(alice);
        assertGt(a0End + a1End, a0 + a1, "the owner was not paid");
    }

    /* ==================================================== Z-7 INPUT VALIDATION */

    /// @notice The three refusals that keep the zap from being an arbitrary swap engine:
    ///         swapping the ENTIRE deposit (nothing left to pair with), a zero deposit, and a zero
    ///         slippage floor (which would disable the only outcome bound the function has).
    function test_attack_zapRefusesSwappingTheWholeDepositAndZeroInputs() public {
        // swapAmount == amountIn: every token becomes the other token, and `minLiquidity` would then
        // be the only thing standing between the caller and a one-sided position built from a swap
        // the vault performed for them.
        vm.prank(alice);
        vm.expectRevert(MolePositions.ZeroLiquidity.selector);
        mole.zapOpen(_zp(LO, HI, true, 100e18, 100e18, 1), block.timestamp);

        // swapAmount > amountIn: the swap would consume tokens the settle never provided.
        vm.prank(alice);
        vm.expectRevert(MolePositions.ZeroLiquidity.selector);
        mole.zapOpen(_zp(LO, HI, true, 100e18, 100e18 + 1, 1), block.timestamp);

        vm.prank(alice);
        vm.expectRevert(MolePositions.ZeroLiquidity.selector);
        mole.zapOpen(_zp(LO, HI, true, 100e18, type(uint256).max, 1), block.timestamp);

        // amountIn == 0.
        vm.prank(alice);
        vm.expectRevert(MolePositions.ZeroLiquidity.selector);
        mole.zapOpen(_zp(LO, HI, true, 0, 0, 1), block.timestamp);

        // minLiquidity == 0 would switch the slippage bound off entirely.
        vm.prank(alice);
        vm.expectRevert(MolePositions.ZeroLiquidity.selector);
        mole.zapOpen(_zp(LO, HI, true, 100e18, 40e18, 0), block.timestamp);

        // Range validation still applies on this path, unchanged.
        vm.prank(alice);
        vm.expectRevert(MolePositions.TicksMisordered.selector);
        mole.zapOpen(_zp(HI, LO, true, 100e18, 40e18, 1), block.timestamp);

        vm.prank(alice);
        vm.expectRevert(MolePositions.TickNotOnSpacing.selector);
        mole.zapOpen(_zp(-61, HI, true, 100e18, 40e18, 1), block.timestamp);

        vm.prank(alice);
        vm.expectRevert(MolePositions.RangeWidthOutOfBounds.selector);
        mole.zapOpen(_zp(-60, 0, true, 100e18, 40e18, 1), block.timestamp);

        assertEq(mole.positionCount(), 0, "a refused zap created a position");
        _assertNoCustody("after every refused zap");
    }

    /// @notice Admission and freshness. A pool this vault never admitted cannot be zapped into —
    ///         which matters more here than on open(), because the zap SWAPS through the pool it is
    ///         given, so an unadmitted pool would let a caller drive the vault's own swap through a
    ///         venue of their choosing.
    function test_attack_zapIntoAnUnwhitelistedPoolOrAfterTheDeadlineIsRefused() public {
        // A real, initialised, perfectly ordinary pool - simply never whitelisted.
        (PoolKey memory strangeKey,) = initPool(currency0, currency1, IHooks(address(0)), 500, SPACING, SQRT_PRICE_1_1);
        assertFalse(mole.isWhitelisted(strangeKey.toId()), "the stranger pool is whitelisted - test is vacuous");

        vm.prank(alice);
        vm.expectRevert(MolePositions.PoolNotWhitelisted.selector);
        mole.zapOpen(_zpKey(strangeKey, LO, HI, true, 100e18, 40e18, 1), block.timestamp);

        // A key that was never initialised at all.
        PoolKey memory ghostKey =
            PoolKey({currency0: currency0, currency1: currency1, fee: 10_000, tickSpacing: 120, hooks: IHooks(address(0))});
        vm.prank(alice);
        vm.expectRevert(MolePositions.PoolNotWhitelisted.selector);
        mole.zapOpen(_zpKey(ghostKey, LO, HI, true, 100e18, 40e18, 1), block.timestamp);

        // Deadline. Checked before everything else, so a stale transaction cannot be replayed into a
        // price it was not signed for.
        vm.warp(block.timestamp + 1000);
        vm.prank(alice);
        vm.expectRevert(MolePositions.DeadlinePassed.selector);
        mole.zapOpen(_zp(LO, HI, true, 100e18, 40e18, 1), block.timestamp - 1);

        assertEq(mole.positionCount(), 0, "a refused zap created a position");
        _assertNoCustody("after unwhitelisted and expired zaps");
    }

    /* ================================================== Z-8 ONE-SIDED RANGES */

    /// @notice Zap into a range ENTIRELY ABOVE spot. Such a range can only hold token0, so the token1
    ///         the zap just bought is unusable. The requirement is that the contract does something
    ///         coherent: mint from the leg it can use, hand the whole other leg back to the owner,
    ///         and leave a position that is fully withdrawable. What must NEVER happen is a position
    ///         that exists but cannot be exited, or a leg that silently stays in the vault.
    function test_attack_zapIntoRangeEntirelyAboveSpotMintsACoherentWithdrawablePosition() public {
        (, int24 tickBefore,,) = manager.getSlot0(key.toId());
        assertLt(tickBefore, 1200, "spot is not below the range - test would be vacuous");

        (uint256 a0, uint256 a1) = _bal(alice);

        vm.prank(alice);
        uint256 id = mole.zapOpen(_zp(1200, 6000, true, 100e18, 50e18, 1), block.timestamp);

        _assertNoCustody("after a zap into a range entirely above spot");

        MolePositions.Position memory p = mole.getPosition(id);
        assertEq(p.owner, alice, "owner wrong");
        assertGt(p.liquidity, 0, "an above-spot zap minted a position with no liquidity");
        assertEq(p.tickLower, 1200, "range moved");
        assertEq(p.tickUpper, 6000, "range moved");

        // The swapped-for token1 is useless to this range, so essentially all of it comes straight
        // back to alice as residual rather than sitting anywhere.
        (uint256 a0Mid, uint256 a1Mid) = _bal(alice);
        assertGt(a1Mid, a1, "the unusable leg was not returned to the owner");
        assertGe(a1Mid - a1, 45e18, "the unusable leg was only partly returned");

        // THE THING THAT MUST NOT FAIL: the position exits.
        _withdrawAll(alice, id);
        (uint256 a0End, uint256 a1End) = _bal(alice);
        assertGt(a0End, a0Mid, "an above-spot position paid nothing on exit");
        _assertNoCustody("after exiting an above-spot zap");

        // Round trip still cannot mint value.
        uint256 returned = (a0End + 100e18 - a0) + (a1End - a1);
        assertLe(returned, 100e18 + 2, "FREE MONEY through an above-spot range");
    }

    /// @notice The mirror image: a range entirely BELOW spot can only hold token1, so the UNSWAPPED
    ///         half of a token0 deposit is the unusable leg and must come back.
    function test_attack_zapIntoRangeEntirelyBelowSpotMintsACoherentWithdrawablePosition() public {
        (, int24 tickBefore,,) = manager.getSlot0(key.toId());
        assertGt(tickBefore, -1200, "spot is not above the range - test would be vacuous");

        (uint256 a0, uint256 a1) = _bal(alice);

        vm.prank(alice);
        uint256 id = mole.zapOpen(_zp(-6000, -1200, true, 100e18, 50e18, 1), block.timestamp);

        _assertNoCustody("after a zap into a range entirely below spot");

        MolePositions.Position memory p = mole.getPosition(id);
        assertEq(p.owner, alice, "owner wrong");
        assertGt(p.liquidity, 0, "a below-spot zap minted a position with no liquidity");

        // Of the 100e18 token0 deposited, 50e18 was swapped away and the other 50e18 cannot be used
        // by this range - so alice's net token0 spend is essentially just the swapped half.
        (uint256 a0Mid, uint256 a1Mid) = _bal(alice);
        assertLe(a0 - a0Mid, 55e18, "the unusable leg was not returned to the owner");
        assertEq(a1Mid, a1, "token1 was paid out before the exit on a below-spot range");

        _withdrawAll(alice, id);
        (uint256 a0End, uint256 a1End) = _bal(alice);
        assertGt(a1End, a1Mid, "a below-spot position paid nothing on exit");
        _assertNoCustody("after exiting a below-spot zap");

        uint256 returned = (a0End + 100e18 - a0) + (a1End - a1);
        assertLe(returned, 100e18 + 2, "FREE MONEY through a below-spot range");
    }

    /* ================================================== Z-9 THE PULL IS BOUNDED */

    /// @notice `_settleFrom(cIn, z.amountIn, owner)` must be the ONLY pull the zap ever makes. The
    ///         mint that follows is paid entirely out of deltas the vault already holds, so it must
    ///         never reach back into the depositor for a wei of rounding.
    ///
    ///         Proven with an allowance of EXACTLY amountIn instead of the usual max: if the contract
    ///         pulled one wei more, transferFrom would revert. A max allowance can never show this.
    function test_attack_zapCannotPullMoreThanAmountInFromTheDepositor() public {
        uint256 amountIn = 100e18;

        vm.startPrank(carol);
        t0.approve(address(mole), 0);
        t0.approve(address(mole), amountIn);
        vm.stopPrank();
        assertEq(t0.allowance(carol, address(mole)), amountIn, "allowance not armed");

        uint256 c0 = t0.balanceOf(carol);

        vm.prank(carol);
        uint256 id = mole.zapOpen(_zp(LO, HI, true, amountIn, 40e18, 1), block.timestamp);

        // Exactly amountIn was pulled: the allowance is spent to the wei, and not a wei more was
        // available to spend.
        assertEq(t0.allowance(carol, address(mole)), 0, "the zap did not consume exactly amountIn");
        assertGt(mole.getPosition(id).liquidity, 0, "zap minted nothing - test would be vacuous");
        _assertNoCustody("after an exact-allowance zap");

        // Carol's net spend is amountIn minus whatever came back as residual - never more.
        assertGe(t0.balanceOf(carol), c0 - amountIn, "more than amountIn left the depositor");
    }

    /* ==================================== Z-1 THE FINDING: DEPOSIT CAP BYPASS */

    /// @notice THE REGRESSION TEST FOR Z-1, THE ONE REAL BUG THIS FILE FOUND. See the header.
    ///
    ///         `maxPositionLiquidity` used to be checked against `z.minLiquidity` — the caller's own
    ///         slippage FLOOR — and never against the liquidity the zap actually minted. The floor is
    ///         freely chosen, so the cap was satisfied by declaring a small one and then depositing as
    ///         much as you liked: the size that gets minted is a function of `amountIn`, which has no
    ///         ceiling anywhere on this path. Written against the unfixed contract, this test measured
    ///         a position more than TEN TIMES a live, configured cap.
    ///
    ///         The contract states what the cap is for: "its real job is stopping THIS VAULT from
    ///         becoming the pool's dominant LP, which is the condition that made the oracle cheap to
    ///         walk in F-4." So it is not a cosmetic bound — it is the one guarding the precondition
    ///         of an oracle-manipulation finding, and every depositor could step over it.
    ///
    ///         Four things are proven here, in order, and all four have to hold for the fix to be a
    ///         fix rather than a trade: the band is REAL on open() (control, unchanged path); the
    ///         DECLARED floor and ceiling are still pre-checked on the zap; the MINTED size is now
    ///         checked too, which is the bug closing; and a deposit that lands inside the band still
    ///         succeeds, so the fix is a bound and not a ban.
    function test_attack_zapCannotBypassTheMaxPositionLiquidityDepositCap() public {
        uint128 FLOOR = 1e18;
        uint128 CAP = 10e18;

        vm.prank(TEST_UPGRADE_ADMIN);
        mole.setPositionSizeBand(FLOOR, CAP);
        assertEq(mole.maxPositionLiquidity(), CAP, "band not set");
        assertEq(mole.minPositionLiquidity(), FLOOR, "band not set");

        // CONTROL 1: the cap is real, and open() enforces it on the size actually minted.
        vm.prank(alice);
        vm.expectRevert(MolePositions.PositionTooLarge.selector);
        mole.open(key, LO, HI, 200e18, type(uint256).max, type(uint256).max, block.timestamp);

        vm.prank(alice);
        vm.expectRevert(MolePositions.PositionTooSmall.selector);
        mole.open(key, LO, HI, 0.5e18, type(uint256).max, type(uint256).max, block.timestamp);

        // CONTROL 2: the FLOOR half of the band DOES bind on a zap, and it binds transitively —
        // `minted >= minLiquidity` is enforced after the unlock, so a position below the floor
        // cannot be created either way. The band is not being ignored wholesale.
        vm.prank(alice);
        vm.expectRevert(MolePositions.PositionTooSmall.selector);
        mole.zapOpen(_zp(LO, HI, true, 100e18, 40e18, FLOOR - 1), block.timestamp);

        vm.prank(alice);
        vm.expectRevert(MolePositions.PositionTooLarge.selector);
        mole.zapOpen(_zp(LO, HI, true, 100e18, 40e18, CAP + 1), block.timestamp);

        // THE BYPASS, NOW CLOSED. Declaring a floor INSIDE the band and depositing 100e18 anyway used to
        // mint >10x the cap, because the band was only ever checked against `z.minLiquidity` — a number
        // the caller chooses. It is now re-checked against what was actually minted, so this reverts.
        vm.prank(alice);
        vm.expectRevert(MolePositions.PositionTooLarge.selector);
        mole.zapOpen(_zp(LO, HI, true, 100e18, 40e18, FLOOR), block.timestamp);

        // ...and a deposit sized to land INSIDE the band still works, so the fix is a bound and not a ban.
        vm.prank(alice);
        uint256 id = mole.zapOpen(_zp(LO, HI, true, 6e18, 2e18, FLOOR), block.timestamp);

        uint128 minted = mole.getPosition(id).liquidity;
        emit log_named_decimal_uint("deposit cap (maxPositionLiquidity)", CAP, 18);
        emit log_named_decimal_uint("liquidity actually minted by zap  ", minted, 18);

        // THE ASSERTION THE BUG BROKE. Before the fix this same call minted >10x the cap.
        assertLe(minted, CAP, "zapOpen minted MORE than maxPositionLiquidity -- the deposit cap is bypassable");

        // ...and the fix did not close the ceiling by breaking the floor: a position that lands inside
        // the band is still a position, at or above the minimum the band declares.
        assertGe(minted, FLOOR, "floor was not honoured");
        assertGt(minted, 0, "no position was minted - the test would be vacuous");

        // Custody is untouched either way - Z-1 was a BOUNDS failure, never a theft - and the position
        // the fix does allow is a real, exitable one.
        _assertNoCustody("after an in-band zap under a live deposit cap");
        _withdrawAll(alice, id);
        _assertNoCustody("after the in-band position was exited");
    }
}
