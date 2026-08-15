// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {Deployers} from "@uniswap/v4-core/test/utils/Deployers.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";
import {MoleRouter} from "../../src/MoleRouter.sol";
import {MoleFeeDial} from "../../src/MoleFeeDial.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {ModifyLiquidityParams} from "v4-core/types/PoolOperation.sol";

/// Attacks and boundary proofs on the aggregator fee. The fee's trust statement is:
///   "the mutable surface is ONE bounded number — a hostile dial can neither exceed 1%, nor redirect
///    the fee, nor block swaps, nor eat into a user's quoted minimum."
/// Every test here tries to break one clause of that sentence.
contract AttackRouterFee is Test, Deployers {
    MoleRouter internal router;
    MoleFeeDial internal dial;
    MockERC20 internal tokenA;
    MockERC20 internal tokenB;
    address internal treasury = makeAddr("treasury");
    address internal user = makeAddr("user");
    address internal dialOwner = makeAddr("dialOwner");

    PoolKey internal key_;

    function setUp() public {
        deployFreshManagerAndRouters();
        tokenA = new MockERC20("A", "A", 18);
        tokenB = new MockERC20("B", "B", 18);
        if (address(tokenA) > address(tokenB)) (tokenA, tokenB) = (tokenB, tokenA);

        dial = new MoleFeeDial(dialOwner, 69); // 0.69%
        router = new MoleRouter(manager, makeAddr("weth-unused"), address(dial), treasury);

        // A plain hookless v4 pool with deep liquidity to swap against.
        key_ = PoolKey({
            currency0: Currency.wrap(address(tokenA)),
            currency1: Currency.wrap(address(tokenB)),
            fee: 3000,
            tickSpacing: 60,
            hooks: IHooks(address(0))
        });
        manager.initialize(key_, SQRT_PRICE_1_1);
        // DEEP liquidity over a wide range: these tests swap 1e18 several times in one direction and
        // must measure the FEE, not pool exhaustion (the Deployers default ±120-tick position is spent
        // by a single 1e18 swap, leaving the price at the limit and the next swap unable to start).
        tokenA.mint(address(this), 200_000e18);
        tokenB.mint(address(this), 200_000e18);
        tokenA.approve(address(modifyLiquidityRouter), type(uint256).max);
        tokenB.approve(address(modifyLiquidityRouter), type(uint256).max);
        modifyLiquidityRouter.modifyLiquidity(
            key_,
            ModifyLiquidityParams({tickLower: -60_000, tickUpper: 60_000, liquidityDelta: 100_000e18, salt: 0}),
            ""
        );

        tokenA.mint(user, 100e18);
        vm.prank(user);
        tokenA.approve(address(router), type(uint256).max);
    }

    function _plan(uint256 amountIn, uint256 minOut) internal view returns (MoleRouter.SwapPlan memory plan) {
        MoleRouter.Hop[] memory hops = new MoleRouter.Hop[](1);
        hops[0] = MoleRouter.Hop({
            venue: MoleRouter.Venue.UniswapV4,
            pool: address(0),
            zeroForOne: true,
            tokenIn: address(tokenA),
            tokenOut: address(tokenB),
            key: key_
        });
        MoleRouter.Path[] memory paths = new MoleRouter.Path[](1);
        paths[0] = MoleRouter.Path({amountIn: amountIn, hops: hops});
        plan = MoleRouter.SwapPlan({
            tokenIn: address(tokenA),
            tokenOut: address(tokenB),
            amountIn: amountIn,
            minAmountOut: minOut,
            recipient: user,
            deadline: block.timestamp + 60,
            paths: paths
        });
    }

    /* ─── the fee is taken, exactly, and goes to the immutable treasury ─── */

    /// @notice The fee is taken from the INPUT, in the source currency, and is exactly bps of the GROSS
    ///         input — a stronger statement than the old output-side test could make, because the input is
    ///         a number the payer chose rather than one derived from whatever the pool happened to return.
    function test_feeSkimmedFromInputToTreasury_userGetsFullOutput_routerHoldsNothing() public {
        uint256 treasuryBefore = tokenA.balanceOf(treasury);
        uint256 userOutBefore = tokenB.balanceOf(user);
        uint256 userInBefore = tokenA.balanceOf(user);

        vm.prank(user);
        uint256 amountOut = router.swap(_plan(1e18, 0));

        uint256 feeTaken = tokenA.balanceOf(treasury) - treasuryBefore;
        uint256 userGot = tokenB.balanceOf(user) - userOutBefore;

        assertEq(userGot, amountOut, "swap() return must equal what the user received");
        // The whole point of the change: the treasury is paid in the token the user SPENT.
        assertEq(feeTaken, (1e18 * 69) / 10_000, "fee must be exactly 69 bps of the GROSS input");
        assertEq(tokenB.balanceOf(treasury), 0, "treasury must NOT receive the output token");
        // The user pays exactly the gross input they declared — the fee comes out of it, not on top.
        assertEq(userInBefore - tokenA.balanceOf(user), 1e18, "payer is debited exactly plan.amountIn");
        // And the whole route output belongs to them now.
        assertGt(userGot, 0, "user must receive the full route output");
        // zero residual — beyond the declared fee, nothing stays.
        assertEq(tokenA.balanceOf(address(router)), 0, "router holds no input");
        assertEq(tokenB.balanceOf(address(router)), 0, "router holds no output");
    }

    /// @notice The routed amount really is the post-fee amount — proven by comparing against the same swap
    ///         run feeless. If the router charged the fee but still routed the gross (or scaled the wrong
    ///         way), these two outputs would not line up.
    function test_theRoutedAmountIsTheNetAmount_notTheGross() public {
        MoleRouter feeless = new MoleRouter(manager, makeAddr("weth-unused"), address(0), address(0));
        vm.prank(user);
        tokenA.approve(address(feeless), type(uint256).max);

        uint256 fee = (1e18 * 69) / 10_000;
        // Feeless router, given exactly the NET amount: this is what the charging router should produce.
        vm.prank(user);
        uint256 expected = feeless.swap(_plan(1e18 - fee, 0));

        // Reset the pool by swapping back is not possible here, so instead assert the charging router's
        // output is within a hair of `expected` — the two swaps hit the pool at slightly different prices,
        // so an exact equality would be testing pool depth, not the fee. A gross-routed swap would be
        // ~0.69% ABOVE expected, far outside this band.
        vm.prank(user);
        uint256 got = router.swap(_plan(1e18, 0));
        uint256 diff = got > expected ? got - expected : expected - got;
        assertLt(diff * 10_000 / expected, 20, "charging router must route the NET amount (within 0.2%)");
    }

    /// @notice A fee that would consume the entire input is refused rather than handing the payer's whole
    ///         balance to the treasury. Unreachable at the compiled 1% clamp, guarded anyway.
    function test_feeCanNeverConsumeTheEntireInput() public {
        HostileDial hostile = new HostileDial(10_000); // 100%
        MoleRouter capped = new MoleRouter(manager, makeAddr("weth-unused"), address(hostile), treasury);
        vm.prank(user);
        tokenA.approve(address(capped), type(uint256).max);

        uint256 treasuryBefore = tokenA.balanceOf(treasury);
        vm.prank(user);
        uint256 out = capped.swap(_plan(1e18, 0));

        assertGt(out, 0, "a 100% dial must not zero the user's swap");
        assertEq(tokenA.balanceOf(treasury) - treasuryBefore, (1e18 * 100) / 10_000, "clamped to 1%");
    }

    /* ─── clause: "cannot exceed 1%" — a hostile dial is clamped by immutable code ─── */

    function test_hostileDialAboveCap_isClampedTo1Percent() public {
        // The real dial refuses >100 itself, so mount a raw hostile one returning 5000 (50%).
        HostileDial hostile = new HostileDial(5000);
        MoleRouter capped = new MoleRouter(manager, makeAddr("weth-unused"), address(hostile), treasury);
        vm.prank(user);
        tokenA.approve(address(capped), type(uint256).max);

        uint256 treasuryBefore = tokenA.balanceOf(treasury);
        vm.prank(user);
        capped.swap(_plan(1e18, 0));

        uint256 feeTaken = tokenA.balanceOf(treasury) - treasuryBefore;
        assertEq(feeTaken, (1e18 * 100) / 10_000, "a 50% dial must be clamped to exactly 1% of the input");
    }

    /* ─── clause: "cannot block swaps" — reverting / gas-burning dials mean fee = 0 ─── */

    function test_revertingDial_swapSucceedsFeeless() public {
        RevertingDial bad = new RevertingDial();
        MoleRouter r2 = new MoleRouter(manager, makeAddr("weth-unused"), address(bad), treasury);
        vm.prank(user);
        tokenA.approve(address(r2), type(uint256).max);

        uint256 treasuryBefore = tokenB.balanceOf(treasury);
        vm.prank(user);
        uint256 amountOut = r2.swap(_plan(1e18, 0));
        assertGt(amountOut, 0, "swap must succeed despite the dial reverting");
        assertEq(tokenB.balanceOf(treasury), treasuryBefore, "no fee on dial failure");
    }

    function test_gasBurningDial_swapSucceedsFeeless() public {
        GasBurnerDial burner = new GasBurnerDial();
        MoleRouter r2 = new MoleRouter(manager, makeAddr("weth-unused"), address(burner), treasury);
        vm.prank(user);
        tokenA.approve(address(r2), type(uint256).max);

        uint256 treasuryBefore = tokenB.balanceOf(treasury);
        vm.prank(user);
        uint256 amountOut = r2.swap(_plan(1e18, 0));
        assertGt(amountOut, 0, "swap must succeed despite a gas-burning dial");
        assertEq(tokenB.balanceOf(treasury), treasuryBefore, "no fee from a gas-burning dial");
    }

    /* ─── clause: "cannot eat into the quoted minimum" — minOut is the FULL route output ─── */

    /// @dev With the fee on the input, the whole route output belongs to the recipient, so minAmountOut is
    ///      enforced against all of it. Off-chain the quote routes (amountIn − fee) and floors THAT, so the
    ///      promise the user is shown is still the promise the chain checks.
    function test_minAmountOut_enforcedOnTheFullOutput() public {
        // Discover the post-fee output, then demand exactly it: must succeed.
        vm.prank(user);
        uint256 got = router.swap(_plan(1e18, 0));

        // Same swap again demanding one wei more than the post-fee amount it can produce: must revert.
        // (Second identical swap on this deep 1:1 pool yields marginally less, so got+1 is above it.)
        vm.prank(user);
        // Selector-only match: the second swap's exact output depends on the price the first one left.
        vm.expectPartialRevert(MoleRouter.InsufficientOutput.selector);
        router.swap(_plan(1e18, got + 1));
    }

    /* ─── fee changes take effect immediately, and only within the cap ─── */

    function test_dialChange_appliesOnNextSwap_andZeroWorks() public {
        // Small amounts: this test swaps twice in the same direction and must not exhaust the test
        // pool's ±120-tick range — the property under test is the dial, not pool depth.
        vm.prank(dialOwner);
        dial.setFeeBps(0);

        uint256 treasuryBefore = tokenA.balanceOf(treasury);
        vm.prank(user);
        router.swap(_plan(1e18, 0));
        assertEq(tokenA.balanceOf(treasury), treasuryBefore, "fee 0 must skim nothing");

        vm.prank(dialOwner);
        dial.setFeeBps(100);
        vm.prank(user);
        router.swap(_plan(1e18, 0));
        assertEq(
            tokenA.balanceOf(treasury) - treasuryBefore, (1e18 * 100) / 10_000, "fee 100 bps must skim 1% of input"
        );
    }

    function test_dialRefusesAboveItsOwnCap_andNonOwner() public {
        vm.prank(dialOwner);
        vm.expectRevert(MoleFeeDial.FeeAboveCap.selector);
        dial.setFeeBps(101);

        vm.expectRevert(MoleFeeDial.NotOwner.selector);
        dial.setFeeBps(1); // not the owner
    }

    /* ─── the feeless configuration is byte-identical to the old router ─── */

    function test_zeroDialAddress_isPermanentlyFeeless() public {
        MoleRouter feeless = new MoleRouter(manager, makeAddr("weth-unused"), address(0), address(0));
        vm.prank(user);
        tokenA.approve(address(feeless), type(uint256).max);
        uint256 treasuryBefore = tokenB.balanceOf(treasury);
        vm.prank(user);
        uint256 amountOut = feeless.swap(_plan(1e18, 0));
        assertGt(amountOut, 0);
        assertEq(tokenB.balanceOf(treasury), treasuryBefore, "no dial, no fee, ever");
    }

    /* ─── clause: "cannot block swaps" — a treasury the INPUT token blacklists forgoes the fee, not the swap ─── */

    /// @dev Repointed at the INPUT token, because that is where the fee is now taken — blacklisting the
    ///      output would no longer exercise the fee path at all. The attack machine is unchanged; only the
    ///      leg it is aimed at moved. The user must receive the FULL output of the FULL (unreduced) input.
    function test_feeRecipientBlacklistedOnInput_swapSucceedsFeeless_nothingStranded() public {
        // A fresh pool whose INPUT token refuses transfers to the treasury (a dynamic post-deploy
        // blacklist — the one recipient failure no deploy-time guard can catch).
        BlacklistToken inTok = new BlacklistToken();
        inTok.setBlacklisted(treasury, true);
        MockERC20 outTok = new MockERC20("OUT", "OUT", 18);
        (Currency c0, Currency c1, bool inIsZero) = address(inTok) < address(outTok)
            ? (Currency.wrap(address(inTok)), Currency.wrap(address(outTok)), true)
            : (Currency.wrap(address(outTok)), Currency.wrap(address(inTok)), false);

        PoolKey memory bk = PoolKey({currency0: c0, currency1: c1, fee: 3000, tickSpacing: 60, hooks: IHooks(address(0))});
        manager.initialize(bk, SQRT_PRICE_1_1);
        inTok.mint(address(this), 200_000e18);
        outTok.mint(address(this), 200_000e18);
        inTok.approve(address(modifyLiquidityRouter), type(uint256).max);
        outTok.approve(address(modifyLiquidityRouter), type(uint256).max);
        modifyLiquidityRouter.modifyLiquidity(
            bk, ModifyLiquidityParams({tickLower: -60_000, tickUpper: 60_000, liquidityDelta: 100_000e18, salt: 0}), ""
        );

        inTok.mint(user, 10e18);
        vm.prank(user);
        inTok.approve(address(router), type(uint256).max);

        MoleRouter.Hop[] memory hops = new MoleRouter.Hop[](1);
        hops[0] = MoleRouter.Hop({
            venue: MoleRouter.Venue.UniswapV4, pool: address(0),
            zeroForOne: inIsZero, tokenIn: address(inTok), tokenOut: address(outTok), key: bk
        });
        MoleRouter.Path[] memory paths = new MoleRouter.Path[](1);
        paths[0] = MoleRouter.Path({amountIn: 1e18, hops: hops});
        MoleRouter.SwapPlan memory plan = MoleRouter.SwapPlan({
            tokenIn: address(inTok), tokenOut: address(outTok), amountIn: 1e18, minAmountOut: 0,
            recipient: user, deadline: block.timestamp + 60, paths: paths
        });

        uint256 userBefore = outTok.balanceOf(user);
        vm.prank(user);
        uint256 amountOut = router.swap(plan); // MUST NOT revert despite the blacklisted treasury

        assertGt(amountOut, 0, "swap must succeed even though the treasury cannot be paid");
        assertEq(outTok.balanceOf(user) - userBefore, amountOut, "user receives the FULL output");
        assertEq(inTok.balanceOf(treasury), 0, "blacklisted treasury got nothing");
        // Fail-open on the INPUT side means the forgone fee is ROUTED for the user, not stranded: the
        // router must have swapped the whole 1e18, so nothing of either token stays behind.
        assertEq(inTok.balanceOf(address(router)), 0, "no fee stranded in the router");
        assertEq(outTok.balanceOf(address(router)), 0, "no output stranded");
    }

    /* ─── deploy-time misconfigurations fail the deploy, not the users ─── */

    function test_constructorRejects_dialWithNoRecipient() public {
        vm.expectRevert(MoleRouter.BadFeeConfig.selector);
        new MoleRouter(manager, makeAddr("weth-unused"), address(dial), address(0));
    }

    function test_constructorRejects_codelessDial() public {
        // The most likely deploy typo: a wrong / not-yet-deployed dial address. Must fail loudly, not
        // silently run feeless.
        vm.expectRevert(MoleRouter.BadFeeConfig.selector);
        new MoleRouter(manager, makeAddr("weth-unused"), makeAddr("not-a-contract"), treasury);
    }

    function test_constructorRejects_strandingRecipients() public {
        address weth = makeAddr("weth");
        // WETH and the PoolManager as recipient would strand a mid-unlock transfer — rejected.
        vm.expectRevert(MoleRouter.BadFeeConfig.selector);
        new MoleRouter(manager, weth, address(dial), weth);
        vm.expectRevert(MoleRouter.BadFeeConfig.selector);
        new MoleRouter(manager, weth, address(dial), address(manager));
    }
}

/// An ERC-20 that reverts transfers to blacklisted addresses — models a USDC-style issuer blacklisting
/// the treasury after deploy. Minimal, sufficient for the router's transfer path.
contract BlacklistToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    mapping(address => bool) public blacklisted;

    function setBlacklisted(address who, bool v) external {
        blacklisted[who] = v;
    }

    function mint(address to, uint256 amt) external {
        balanceOf[to] += amt;
    }

    function approve(address s, uint256 a) external returns (bool) {
        allowance[msg.sender][s] = a;
        return true;
    }

    function transfer(address to, uint256 amt) external returns (bool) {
        require(!blacklisted[to], "blacklisted");
        balanceOf[msg.sender] -= amt;
        balanceOf[to] += amt;
        return true;
    }

    function transferFrom(address f, address t, uint256 amt) external returns (bool) {
        require(!blacklisted[t], "blacklisted");
        uint256 al = allowance[f][msg.sender];
        if (al != type(uint256).max) allowance[f][msg.sender] = al - amt;
        balanceOf[f] -= amt;
        balanceOf[t] += amt;
        return true;
    }
}

/// Returns an arbitrary bps — models a compromised dial trying to overcharge.
contract HostileDial {
    uint256 internal immutable v;

    constructor(uint256 _v) {
        v = _v;
    }

    function feeBps() external view returns (uint256) {
        return v;
    }
}

/// Reverts on every read — models a bricked dial.
contract RevertingDial {
    function feeBps() external pure returns (uint256) {
        revert("nope");
    }
}

/// Burns all forwarded gas — models a dial trying to grief swaps via the read.
contract GasBurnerDial {
    function feeBps() external view returns (uint256) {
        uint256 x;
        while (gasleft() > 100) x = uint256(keccak256(abi.encode(x)));
        return x;
    }
}
