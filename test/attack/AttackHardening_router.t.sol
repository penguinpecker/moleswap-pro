// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {MoleRouter} from "../../src/MoleRouter.sol";
import {MoleFeeDial} from "../../src/MoleFeeDial.sol";
import {HardeningBase} from "../helpers/HardeningBase.sol";
import {deployMoleRouter} from "../helpers/ProxyDeploy.sol";

/*//////////////////////////////////////////////////////////////////////////////
                                   F I N D I N G S

  Target:  MoleRouter's zero-residual invariant (Part 19.5/19.6), RE-ASSERTED under the three shapes
           the audit named — over-receive, short-fill, self-recipient — but COMPOSED rather than one
           at a time, with the input-side fee on, payer != recipient, a v4 hop in the chain, and the
           native-out edge. The single-shape tests live in AttackMoleRouter.t.sol; these are the
           combinations a route can actually present.

  RESULT: HOLDS. After every swap the router holds zero of EVERY token the route touched and zero
  ETH; the recipient receives exactly the TRACKED output; every over-receive and every unconsumed
  intermediate goes back to the PAYER; the treasury receives exactly floor(amountIn * bps / 10000) of
  the INPUT token; the router as recipient is refused on the ERC-20 and the native path alike.

  Mutation: delete `if (plan.recipient == address(this)) revert ZeroRecipient();` -> the self-recipient
  tests go RED; delete the `nowBal > startBal[i]` sweep branch -> every over-receive/short-fill test
  goes RED (the residual strands).
//////////////////////////////////////////////////////////////////////////////*/

/// @dev A v3-style pool that can over-deliver and under-consume at once: it CONSUMES `fillBps` of what
///      was offered, reports `consumed * num / den` as the output, and TRANSFERS `overBps` more than
///      it reported. Both knobs at 10_000 / 0 make it an honest constant-rate pool.
contract ShapedV3Pool {
    address public immutable token0;
    address public immutable token1;
    uint256 public immutable num;
    uint256 public immutable den;
    uint16 public immutable fillBps;
    uint16 public immutable overBps;

    constructor(address _t0, address _t1, uint256 _num, uint256 _den, uint16 _fillBps, uint16 _overBps) {
        (token0, token1) = _t0 < _t1 ? (_t0, _t1) : (_t1, _t0);
        num = _num;
        den = _den;
        fillBps = _fillBps;
        overBps = _overBps;
    }

    function swap(address recipient, bool zeroForOne, int256 amountSpecified, uint160, bytes calldata data)
        external
        returns (int256 a0, int256 a1)
    {
        uint256 offered = uint256(amountSpecified);
        uint256 consumed = offered * fillBps / 10_000;
        uint256 out = consumed * num / den;
        (address tin, address tout) = zeroForOne ? (token0, token1) : (token1, token0);
        IERC20Like(tout).transfer(recipient, out * (10_000 + overBps) / 10_000);
        (a0, a1) = zeroForOne ? (int256(consumed), -int256(out)) : (-int256(out), int256(consumed));
        uint256 before = IERC20Like(tin).balanceOf(address(this));
        IV3Callback(msg.sender).pancakeV3SwapCallback(a0, a1, data);
        require(IERC20Like(tin).balanceOf(address(this)) >= before + consumed, "pool: unpaid");
    }
}

interface IERC20Like {
    function balanceOf(address) external view returns (uint256);
    function transfer(address, uint256) external returns (bool);
}

interface IV3Callback {
    function pancakeV3SwapCallback(int256, int256, bytes calldata) external;
}

contract AttackHardeningRouter is HardeningBase {
    MockERC20 internal tokenC;
    MoleRouter internal feeRouter;
    MoleFeeDial internal dial;
    uint16 internal constant FEE_BPS = 69;

    address internal constant NATIVE = 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE;

    function setUp() public {
        _buildWorld(0);
        tokenC = new MockERC20("C", "C", 18);
        dial = new MoleFeeDial(address(this), FEE_BPS);
        feeRouter = deployMoleRouter(manager, address(weth), address(dial), TREASURY);
        address[3] memory users = [alice, bob, mallory];
        for (uint256 i; i < users.length; ++i) {
            tokenC.mint(users[i], FUNDING);
            vm.startPrank(users[i]);
            t0.approve(address(feeRouter), type(uint256).max);
            t1.approve(address(feeRouter), type(uint256).max);
            tokenC.approve(address(feeRouter), type(uint256).max);
            tokenC.approve(address(router), type(uint256).max);
            vm.stopPrank();
        }
    }

    /* ------------------------------------------------------------------ helpers */

    function _emptyKey() internal pure returns (PoolKey memory k) {
        k = PoolKey(Currency.wrap(address(0)), Currency.wrap(address(0)), 0, 0, IHooks(address(0)));
    }

    function _v3Hop(address pool, address tin, address tout) internal pure returns (MoleRouter.Hop memory) {
        return MoleRouter.Hop(MoleRouter.Venue.PancakeV3, pool, tin < tout, tin, tout, _emptyKey());
    }

    function _fundPool(ShapedV3Pool p, MockERC20 a, MockERC20 b) internal {
        a.mint(address(p), 1_000_000e18);
        b.mint(address(p), 1_000_000e18);
    }

    function _assertRouterEmpty(MoleRouter r, string memory when) internal view {
        assertEq(t0.balanceOf(address(r)), 0, string.concat("router holds t0: ", when));
        assertEq(t1.balanceOf(address(r)), 0, string.concat("router holds t1: ", when));
        assertEq(tokenC.balanceOf(address(r)), 0, string.concat("router holds C: ", when));
        assertEq(weth.balanceOf(address(r)), 0, string.concat("router holds WETH: ", when));
        assertEq(address(r).balance, 0, string.concat("router holds ETH: ", when));
        assertEq(manager.balanceOf(address(r), currency0.toId()), 0, string.concat("router holds claims 0: ", when));
        assertEq(manager.balanceOf(address(r), currency1.toId()), 0, string.concat("router holds claims 1: ", when));
    }

    /* ================================================================ 1. composed over-receive + short-fill, fee on */

    /// @notice Hop 1 over-delivers the intermediate by 50%; hop 2 consumes only 40% of it. Fee on the
    ///         input. Payer alice, recipient bob. Every wei is accounted: treasury gets the exact fee,
    ///         bob the exact tracked output, alice every residual, router nothing.
    function test_overReceiveThenShortFillWithFeeOn_everyWeiIsAttributed() public {
        ShapedV3Pool ab = new ShapedV3Pool(address(t0), address(t1), 2, 1, 10_000, 5_000); // A->B 1:2, +50% over
        ShapedV3Pool bc = new ShapedV3Pool(address(t1), address(tokenC), 1, 1, 4_000, 0); // B->C 1:1, fills 40%
        _fundPool(ab, t0, t1);
        _fundPool(bc, t1, tokenC);

        MoleRouter.Hop[] memory hops = new MoleRouter.Hop[](2);
        hops[0] = _v3Hop(address(ab), address(t0), address(t1));
        hops[1] = _v3Hop(address(bc), address(t1), address(tokenC));
        MoleRouter.Path[] memory paths = new MoleRouter.Path[](1);
        uint256 amt = 100e18;
        paths[0] = MoleRouter.Path(amt, hops);
        MoleRouter.SwapPlan memory plan =
            MoleRouter.SwapPlan(address(t0), address(tokenC), amt, 1, bob, block.timestamp + 1, paths);

        (uint256 a0, uint256 a1) = _bal(alice);
        uint256 aC = tokenC.balanceOf(alice);
        uint256 bC = tokenC.balanceOf(bob);
        (uint256 tr0,) = _bal(TREASURY);

        vm.prank(alice);
        uint256 got = feeRouter.swap(plan);

        uint256 fee = amt * FEE_BPS / 10_000;
        uint256 routed = amt - fee; // one path: mulDiv(amt, amt - fee, amt) is exact
        uint256 bReported = routed * 2; // hop 1 reports 1:2 on the routed amount
        uint256 bReceived = bReported * 15_000 / 10_000; // ...and delivers 1.5x of that
        uint256 bConsumed = bReported * 4_000 / 10_000; // hop 2 eats 40% of the TRACKED amount
        uint256 cTracked = bConsumed; // 1:1

        assertEq(got, cTracked, "tracked output is not what hop 2 reported");
        assertEq(tokenC.balanceOf(bob) - bC, cTracked, "recipient did not get exactly the tracked output");
        (uint256 b0, uint256 b1) = _bal(alice);
        assertEq(a0 - b0, amt, "payer did not pay exactly amountIn of the input");
        assertEq(b1 - a1, bReceived - bConsumed, "payer was not swept the over-receive + unconsumed intermediate");
        assertEq(tokenC.balanceOf(alice), aC, "payer received output token they were not owed");
        (uint256 tr1,) = _bal(TREASURY);
        assertEq(tr1 - tr0, fee, "treasury did not receive exactly floor(amountIn * bps / 10000) in the INPUT token");
        _assertRouterEmpty(feeRouter, "after the composed route");
    }

    /* ================================================================ 2. self-recipient, both paths */

    function test_selfRecipientIsRefusedOnTheErc20Path() public {
        ShapedV3Pool ab = new ShapedV3Pool(address(t0), address(t1), 1, 1, 10_000, 0);
        _fundPool(ab, t0, t1);
        MoleRouter.Hop[] memory hops = new MoleRouter.Hop[](1);
        hops[0] = _v3Hop(address(ab), address(t0), address(t1));
        MoleRouter.Path[] memory paths = new MoleRouter.Path[](1);
        paths[0] = MoleRouter.Path(10e18, hops);
        MoleRouter.SwapPlan memory plan =
            MoleRouter.SwapPlan(address(t0), address(t1), 10e18, 1, address(feeRouter), block.timestamp + 1, paths);
        vm.prank(alice);
        vm.expectRevert(MoleRouter.ZeroRecipient.selector);
        feeRouter.swap(plan);
        _assertRouterEmpty(feeRouter, "after refused self-recipient (erc20)");
    }

    /// @notice Native OUT with the router as recipient: `_sendNative(router)` would be a self-send of
    ///         unwrapped ETH. Refused at the same guard, before any token moves.
    function test_selfRecipientIsRefusedOnTheNativeOutPath() public {
        ShapedV3Pool aw = new ShapedV3Pool(address(t0), address(weth), 1, 1, 10_000, 0);
        t0.mint(address(aw), 1_000e18);
        weth.deposit{value: 100e18}();
        weth.transfer(address(aw), 100e18);
        MoleRouter.Hop[] memory hops = new MoleRouter.Hop[](1);
        hops[0] = _v3Hop(address(aw), address(t0), address(weth));
        MoleRouter.Path[] memory paths = new MoleRouter.Path[](1);
        paths[0] = MoleRouter.Path(10e18, hops);
        MoleRouter.SwapPlan memory plan =
            MoleRouter.SwapPlan(address(t0), NATIVE, 10e18, 1, address(router), block.timestamp + 1, paths);
        vm.prank(alice);
        vm.expectRevert(MoleRouter.ZeroRecipient.selector);
        router.swap(plan);
        _assertRouterEmpty(router, "after refused self-recipient (native)");
    }

    /* ================================================================ 3. native out + over-receive */

    /// @notice The pool over-delivers WETH on a NATIVE-out route. The recipient receives exactly the
    ///         tracked amount as ETH; the over-receive is unwrapped and returned to the PAYER as ETH; the
    ///         router ends with zero WETH and zero ETH.
    function test_nativeOutOverReceive_isUnwrappedToThePayerAndTheRouterHoldsNoEth() public {
        ShapedV3Pool aw = new ShapedV3Pool(address(t0), address(weth), 1, 1, 10_000, 3_000); // +30% over
        t0.mint(address(aw), 1_000e18);
        weth.deposit{value: 200e18}();
        weth.transfer(address(aw), 200e18);
        MoleRouter.Hop[] memory hops = new MoleRouter.Hop[](1);
        hops[0] = _v3Hop(address(aw), address(t0), address(weth));
        MoleRouter.Path[] memory paths = new MoleRouter.Path[](1);
        paths[0] = MoleRouter.Path(10e18, hops);
        MoleRouter.SwapPlan memory plan = MoleRouter.SwapPlan(address(t0), NATIVE, 10e18, 1, bob, block.timestamp + 1, paths);

        uint256 bobEth = bob.balance;
        uint256 aliceEth = alice.balance;
        vm.prank(alice);
        uint256 got = router.swap(plan);

        assertEq(got, 10e18, "tracked output drifted");
        assertEq(bob.balance - bobEth, 10e18, "recipient did not get exactly the tracked ETH");
        assertEq(alice.balance - aliceEth, 3e18, "payer was not returned the over-received ETH");
        _assertRouterEmpty(router, "after native-out over-receive");
    }

    /* ================================================================ 4. v4 hop then v3 over-pay */

    /// @notice A route that leaves the PoolManager (v4 hop) and then over-receives on a v3 hop. The v4
    ///         leg settles to zero delta inside the unlock; the v3 over-receive is swept; nothing stays.
    function test_v4HopThenV3OverPay_zeroResidualAcrossThreeTokens() public {
        ShapedV3Pool bc = new ShapedV3Pool(address(t1), address(tokenC), 1, 1, 10_000, 2_000); // +20% over
        _fundPool(bc, t1, tokenC);
        MoleRouter.Hop[] memory hops = new MoleRouter.Hop[](2);
        hops[0] = MoleRouter.Hop(MoleRouter.Venue.UniswapV4, address(0), true, address(t0), address(t1), hookKey);
        hops[1] = _v3Hop(address(bc), address(t1), address(tokenC));
        MoleRouter.Path[] memory paths = new MoleRouter.Path[](1);
        paths[0] = MoleRouter.Path(10e18, hops);
        MoleRouter.SwapPlan memory plan =
            MoleRouter.SwapPlan(address(t0), address(tokenC), 10e18, 1, bob, block.timestamp + 1, paths);

        (uint256 a0, uint256 a1) = _bal(alice);
        uint256 bC = tokenC.balanceOf(bob);
        uint256 aC = tokenC.balanceOf(alice);
        vm.prank(alice);
        uint256 got = feeRouter.swap(plan);

        assertGt(got, 0, "no output");
        assertEq(tokenC.balanceOf(bob) - bC, got, "recipient did not get the tracked output");
        // The v3 over-pay (20% of the tracked C) is C sitting in the router after delivery: swept to alice.
        assertEq(tokenC.balanceOf(alice) - aC, got * 2_000 / 10_000, "the over-received C was not swept to the payer");
        (uint256 b0, uint256 b1) = _bal(alice);
        assertEq(a0 - b0, 10e18, "input not consumed exactly");
        assertEq(b1, a1, "payer received intermediate they were not owed (v4 leg settled wrong)");
        _assertRouterEmpty(feeRouter, "after v4->v3 over-pay route");
    }

    /* ================================================================ 5. fuzz: any shape, zero residual */

    /// @notice Whatever the over-pay, the fill ratio, the size and the fee, the router ends every swap
    ///         holding nothing, the recipient gets the tracked output, and the payer is made whole for
    ///         everything else.
    /// forge-config: default.fuzz.runs = 512
    function testFuzz_zeroResidualUnderAnyOverPayAndFill(uint16 overBps, uint16 fillBps, uint96 amtRaw, uint8 feeRaw) public {
        overBps = uint16(bound(overBps, 0, 20_000));
        fillBps = uint16(bound(fillBps, 1, 10_000));
        uint256 amt = bound(uint256(amtRaw), 1e6, 100_000e18);
        uint16 feeBps = uint16(bound(feeRaw, 0, 100));
        dial.setFeeBps(feeBps);

        ShapedV3Pool ab = new ShapedV3Pool(address(t0), address(t1), 3, 2, fillBps, overBps);
        _fundPool(ab, t0, t1);
        MoleRouter.Hop[] memory hops = new MoleRouter.Hop[](1);
        hops[0] = _v3Hop(address(ab), address(t0), address(t1));
        MoleRouter.Path[] memory paths = new MoleRouter.Path[](1);
        paths[0] = MoleRouter.Path(amt, hops);
        MoleRouter.SwapPlan memory plan = MoleRouter.SwapPlan(address(t0), address(t1), amt, 0, bob, block.timestamp + 1, paths);

        (uint256 a0, uint256 a1) = _bal(alice);
        (uint256 b0, uint256 b1) = _bal(bob);
        (uint256 tr0, uint256 tr1) = _bal(TREASURY);
        vm.prank(alice);
        uint256 got = feeRouter.swap(plan);

        uint256 fee = amt * feeBps / 10_000;
        uint256 routed = amt - fee;
        uint256 consumed = routed * fillBps / 10_000;
        uint256 reported = consumed * 3 / 2;
        uint256 delivered = reported * (10_000 + overBps) / 10_000;

        assertEq(got, reported, "tracked output is not what the pool reported");
        (uint256 c0, uint256 c1) = _bal(bob);
        assertEq(c0, b0, "recipient received input token");
        assertEq(c1 - b1, reported, "recipient did not receive exactly the tracked output");
        (uint256 d0, uint256 d1) = _bal(alice);
        assertEq(a0 - d0, fee + consumed, "payer paid more than fee + what the pool consumed");
        assertEq(d1 - a1, delivered - reported, "payer was not swept exactly the over-receive");
        (uint256 e0, uint256 e1) = _bal(TREASURY);
        assertEq(e0 - tr0, fee, "treasury fee drifted");
        assertEq(e1, tr1, "treasury received output token");
        _assertRouterEmpty(feeRouter, "after fuzzed shape");
    }
}
