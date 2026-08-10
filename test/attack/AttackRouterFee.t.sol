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

    function test_feeSkimmedToTreasury_userGetsRemainder_routerHoldsNothing() public {
        uint256 treasuryBefore = tokenB.balanceOf(treasury);
        uint256 userBefore = tokenB.balanceOf(user);

        vm.prank(user);
        uint256 amountOut = router.swap(_plan(1e18, 0));

        uint256 feeTaken = tokenB.balanceOf(treasury) - treasuryBefore;
        uint256 userGot = tokenB.balanceOf(user) - userBefore;

        assertEq(userGot, amountOut, "swap() return must equal what the user received");
        assertGt(feeTaken, 0, "0.69% fee must be nonzero on a 1e18 swap");
        // fee = floor(raw * 69 / 10000) => raw = userGot + feeTaken and fee/(raw) ~ 0.69%
        uint256 raw = userGot + feeTaken;
        assertEq(feeTaken, (raw * 69) / 10_000, "fee must be exactly 69 bps of the raw output");
        // zero residual — beyond the declared fee, nothing stays.
        assertEq(tokenA.balanceOf(address(router)), 0, "router holds no input");
        assertEq(tokenB.balanceOf(address(router)), 0, "router holds no output");
    }

    /* ─── clause: "cannot exceed 1%" — a hostile dial is clamped by immutable code ─── */

    function test_hostileDialAboveCap_isClampedTo1Percent() public {
        // The real dial refuses >100 itself, so mount a raw hostile one returning 5000 (50%).
        HostileDial hostile = new HostileDial(5000);
        MoleRouter capped = new MoleRouter(manager, makeAddr("weth-unused"), address(hostile), treasury);
        vm.prank(user);
        tokenA.approve(address(capped), type(uint256).max);

        uint256 treasuryBefore = tokenB.balanceOf(treasury);
        uint256 userBefore = tokenB.balanceOf(user);
        vm.prank(user);
        capped.swap(_plan(1e18, 0));

        uint256 feeTaken = tokenB.balanceOf(treasury) - treasuryBefore;
        uint256 raw = (tokenB.balanceOf(user) - userBefore) + feeTaken;
        assertEq(feeTaken, (raw * 100) / 10_000, "a 50% dial must be clamped to exactly 1%");
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

    /* ─── clause: "cannot eat into the quoted minimum" — minOut is post-fee ─── */

    function test_minAmountOut_enforcedOnPostFeeAmount() public {
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

        uint256 treasuryBefore = tokenB.balanceOf(treasury);
        vm.prank(user);
        router.swap(_plan(1e18, 0));
        assertEq(tokenB.balanceOf(treasury), treasuryBefore, "fee 0 must skim nothing");

        vm.prank(dialOwner);
        dial.setFeeBps(100);
        vm.prank(user);
        router.swap(_plan(1e18, 0));
        assertGt(tokenB.balanceOf(treasury), treasuryBefore, "fee 100 bps must skim");
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

    /* ─── clause: "cannot block swaps" — a treasury the OUTPUT token blacklists forgoes the fee, not the swap ─── */

    function test_feeRecipientBlacklisted_swapSucceedsFeeless_nothingStranded() public {
        // Build a fresh pool whose OUTPUT token refuses transfers to the treasury (a dynamic post-deploy
        // blacklist — the one recipient failure no deploy-time guard can catch).
        BlacklistToken outTok = new BlacklistToken();
        outTok.setBlacklisted(treasury, true);
        MockERC20 inTok = new MockERC20("IN", "IN", 18);
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
        assertEq(outTok.balanceOf(user) - userBefore, amountOut, "user receives the FULL output (fee forgone)");
        assertEq(outTok.balanceOf(treasury), 0, "blacklisted treasury got nothing");
        assertEq(outTok.balanceOf(address(router)), 0, "no fee stranded in the router");
        assertEq(inTok.balanceOf(address(router)), 0, "no input stranded");
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
