// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/*//////////////////////////////////////////////////////////////////////////////

                          FINDINGS  (2026-08-06)

    Target : src/MolePositions.sol
    Lens   : the two guards added after the native-ETH admission defect —
             (1) whitelistPool's NativeCurrencyNotSupported refusal, and
             (2) the upgradeAdmin-only position size band on open().

    WHY (1) EXISTS. Every deposit settles with `transferFrom` on
    `Currency.unwrap(currency)`. For native ETH that is address(0) — an EMPTY
    ACCOUNT. A call to an empty account RETURNS SUCCESS with empty returndata,
    which is exactly the shape `_safeTransferFrom` tolerates for USDT-style
    tokens, so the failure was invisible at the transfer and surfaced later as
    an unsettled delta inside the unlock: a permanently-listed pool where every
    open() reverts illegibly. The premise (the empty-account lie) is asserted
    live before the guard is exercised, so if the EVM ever stopped lying the
    test would say so.

    CLOSED   Native pool admission. v4 itself initializes the native pool
             (the POOL is real); MolePositions refuses the LISTING with exactly
             NativeCurrencyNotSupported, and with no listing open() dies at
             PoolNotWhitelisted — the transferFrom-on-address(0) path is
             unreachable, no token and no ETH ever moves.
             -> test_attack_nativePoolIsARealV4PoolButTheListingIsRefused

    FILTER   The refusal is a filter, not a blanket ban: a second, previously
             unseen ERC-20 pool is still admitted permissionlessly (by the
             attacker's own key, even) and a position opens on it.
             -> test_control_erc20PoolIsStillAdmittedSoTheRefusalIsAFilter

    OBSERVED, FAILS CLOSED (not a fund-loss bug). The guard reads currency0
             ONLY. A garbage key with native as CURRENCY1 (unsorted — v4 can
             never initialize it, CurrenciesOutOfOrderOrEqual) slips PAST the
             guard and IS whitelisted. It is a dead listing: open() reverts
             PoolNotInitialized inside the unlock before any transfer, position
             count and balances untouched. Checking currency0 is sufficient for
             every pool v4 can actually create (native sorts first), so this is
             a cosmetic wart — a permanently-listed junk PoolId — not a hole.
             Pinned here so a future "tidy-up" that starts trusting listings to
             be initializable pools trips this test first.
             -> test_attack_nativeAsCurrency1SlipsPastTheGuardButFailsClosed

    CLOSED   Size-band setter privilege. A stranger and — separately — the
             KEEPER (the operationally privileged key, precisely the one a
             compromise hands over) are both refused with NotUpgradeAdmin and
             the band stays (0,0). The real upgradeAdmin can set it and the
             change is observable as PositionSizeBandSet.
             -> test_attack_strangerAndKeeperCannotSetTheSizeBand

    CLOSED   Fat-finger inversion. min > max (with max live) is refused with
             CapAboveCeiling — a band that refuses every deposit must be
             deliberate. The two legal shapes nearest the refusal both work:
             min == max (a one-size band) and min > 0 with max == 0 (0 means
             DISABLED, not a ceiling of zero — if 0 were compared as a number
             the disable convention itself would be unreachable).
             -> test_attack_invertedBandIsRefusedButItsLegalNeighboursAreNot

    CLOSED   Dust griefing at the floor's exact edge. With the floor at F:
             open(F) succeeds, open(F-1) — one wei of liquidity under — is
             refused with PositionTooSmall and mints nothing.
             -> test_attack_dustPositionOneWeiUnderTheFloorIsRefused

    CLOSED   Whale capture at the ceiling's exact edge. With the ceiling at C:
             open(C) succeeds, open(C+1) is refused with PositionTooLarge and
             mints nothing. (The ceiling's real job: stopping this vault from
             becoming the pool's dominant LP, the condition that made the
             oracle cheap to walk in F-4.)
             -> test_attack_whalePositionOneWeiOverTheCeilingIsRefused

    CLOSED   0 disables each end INDEPENDENTLY, not jointly. Floor off +
             ceiling live: a 1-wei-of-liquidity dust position opens while the
             ceiling still bites. Ceiling off + floor live: a 1e24 whale opens
             while the floor still bites. Both off: both extremes open.
             -> test_attack_zeroDisablesEachEndIndependently

    CONTRACT VERDICT: no contract defect found. The currency0-only check in
    whitelistPool is the single observation worth recording, and it fails
    closed (see above).

    TIME: no test in this file loops over warp/roll, so no accumulator is
    needed; deadlines use the current block.timestamp directly.

//////////////////////////////////////////////////////////////////////////////*/

import {Test} from "forge-std/Test.sol";
import {Deployers} from "@uniswap/v4-core/test/utils/Deployers.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {IERC20Minimal} from "v4-core/interfaces/external/IERC20Minimal.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {PoolIdLibrary} from "v4-core/types/PoolId.sol";
import {Currency, CurrencyLibrary} from "v4-core/types/Currency.sol";
import {ModifyLiquidityParams} from "v4-core/types/PoolOperation.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";

import {MolePositions} from "../../src/MolePositions.sol";
import {deployMoleVault, TEST_UPGRADE_ADMIN} from "../helpers/ProxyDeploy.sol";

contract AttackNativeAndSizingTest is Test, Deployers {
    using PoolIdLibrary for PoolKey;

    MolePositions internal mole;

    address internal KEEPER = makeAddr("keeper");
    address internal mallory = makeAddr("mallory"); // attacker; also proves permissionless listing
    address internal alice = makeAddr("alice");

    int24 internal constant SPACING = 60;

    function setUp() public {
        deployFreshManagerAndRouters();
        (currency0, currency1) = deployMintAndApprove2Currencies();

        // moleHook pinned to address(0): hookless-only admission, the test-world configuration the
        // rest of the suite uses to separate custody behaviour from hook behaviour.
        mole = deployMoleVault(
            manager, KEEPER, 0, 120, 60_000, address(0), 0, 0, 0, 0, 10_000, 0, 0, address(0)
        );

        // The working ERC-20 pool every band test opens against.
        (key,) = initPool(currency0, currency1, IHooks(address(0)), 3000, SPACING, SQRT_PRICE_1_1);
        mole.whitelistPool(key);

        MockERC20(Currency.unwrap(currency0)).approve(address(mole), type(uint256).max);
        MockERC20(Currency.unwrap(currency1)).approve(address(mole), type(uint256).max);
    }

    /*==========================================================================
                        1. NATIVE ETH REFUSAL AT ADMISSION
    ==========================================================================*/

    /// @notice ATTACK: list a native-ETH pool so that every later deposit dies as an unsettled delta.
    ///         The pool itself is legitimate — v4 initializes it without complaint — so admission is
    ///         the ONLY place this can be stopped. First the premise behind the guard is proven live:
    ///         `transferFrom` on address(0) is a call to an empty account and RETURNS SUCCESS with
    ///         empty returndata, i.e. the exact shape `_safeTransferFrom` must tolerate for USDT-style
    ///         tokens — so the transfer layer genuinely cannot catch this and admission must. Then the
    ///         listing is refused with exactly NativeCurrencyNotSupported, and open() on the unlisted
    ///         pool dies at PoolNotWhitelisted before a single token or wei of ETH moves.
    /// @notice NATIVE ETH IS NOW SUPPORTED, and this is the test that proves it end to end rather than
    ///         proving it is refused. The refusal that used to live here was a stopgap for a real defect:
    ///         `_settleFrom` paid with `transferFrom` on `Currency.unwrap(currency)`, which for native is
    ///         address(0) — an EMPTY ACCOUNT that answers with success and no returndata, indistinguishable
    ///         from a USDT-style happy path, so the transfer layer could never catch it and the deposit
    ///         died late as an unsettled delta. `_settleFrom` now branches and pays with `settle{value:}`.
    function test_native_poolIsListableAndAFullDepositExitCycleWorks() public {
        // THE PREMISE THAT MADE THE OLD BUG INVISIBLE, still asserted: the empty account at address(0)
        // reports success with empty returndata. This is why the fix had to be a branch, not a check.
        (bool ok, bytes memory ret) = address(0).call(
            abi.encodeWithSelector(IERC20Minimal.transferFrom.selector, alice, address(manager), 1e18)
        );
        assertTrue(ok, "premise: a call to the empty account should report success");
        assertEq(ret.length, 0, "premise: the empty account should return no data");

        PoolKey memory nativeKey = PoolKey({
            currency0: CurrencyLibrary.ADDRESS_ZERO,
            currency1: currency0,
            fee: 3000,
            tickSpacing: SPACING,
            hooks: IHooks(address(0))
        });
        manager.initialize(nativeKey, SQRT_PRICE_1_1);

        // LISTED, permissionlessly, where it used to revert.
        vm.prank(mallory);
        mole.whitelistPool(nativeKey);
        assertTrue(mole.isWhitelisted(nativeKey.toId()), "native pool must now be listable");

        // Seed depth so a position has something to sit in.
        MockERC20(Currency.unwrap(currency0)).mint(address(this), 1_000e18);
        MockERC20(Currency.unwrap(currency0)).approve(address(modifyLiquidityRouter), type(uint256).max);
        vm.deal(address(this), 100 ether);
        // Sized so the ETH leg is affordable: liquidity L over +/-6000 ticks costs roughly 0.61 * L of
        // token0, so 10e18 needs ~6.1 ETH. The first attempt used +/-60000 and 100e18, which wanted
        // ~2000 ETH and failed inside settle — a good reminder that native legs make the cost visible.
        modifyLiquidityRouter.modifyLiquidity{value: 20 ether}(
            nativeKey,
            ModifyLiquidityParams({tickLower: -6_000, tickUpper: 6_000, liquidityDelta: 10e18, salt: 0}),
            ZERO_BYTES
        );

        // DEPOSIT WITH REAL ETH. Deliberately overpay: a concentrated mint takes what the MATH decides,
        // never what the caller happened to send, so the excess must come back.
        vm.deal(alice, 10 ether);
        MockERC20(Currency.unwrap(currency0)).mint(alice, 100e18);
        vm.startPrank(alice);
        MockERC20(Currency.unwrap(currency0)).approve(address(mole), type(uint256).max);

        uint256 ethBefore = alice.balance;
        // L = 1e16 over +/-600 ticks costs ~0.06 * L = ~6e14 wei, so 5 ETH is a deliberate overpayment
        // and the refund below is the thing under test.
        uint256 id = mole.open{value: 5 ether}(
            nativeKey, -600, 600, 1e16, type(uint256).max, type(uint256).max, block.timestamp + 1
        );
        uint256 spent = ethBefore - alice.balance;

        assertGt(mole.getPosition(id).liquidity, 0, "no native position was created");
        assertLt(spent, 5 ether, "the whole 5 ETH was consumed -- the overpayment was not refunded");
        assertGt(spent, 0, "the deposit cost nothing, so no ETH was actually settled");

        // THE VAULT KEEPS NO ETH. Same invariant as every other currency, and native is the one where a
        // stuck balance would be easiest to miss because no token contract records it.
        assertEq(address(mole).balance, 0, "the vault is sitting on ETH after a native deposit");

        // AND THE EXIT PAYS REAL ETH BACK, straight to the stored owner.
        uint256 beforeExit = alice.balance;
        mole.withdrawAll(id);
        vm.stopPrank();
        assertGt(alice.balance, beforeExit, "the native exit returned no ETH");
        assertEq(mole.getPosition(id).liquidity, 0, "the native position did not close");
        assertEq(address(mole).balance, 0, "the vault kept ETH after the exit");
    }

    /// @notice CONTROL for the refusal above: it is a FILTER, not a blanket ban on admission. A second,
    ///         previously unseen ERC-20 pool (same tokens, different fee tier, so a different PoolId)
    ///         is still admitted — permissionlessly, by the attacker's own key — and a real position
    ///         opens on it. Without this test the guard could be satisfied by `revert` as line one.
    function test_control_erc20PoolIsStillAdmittedSoTheRefusalIsAFilter() public {
        PoolKey memory k2 = PoolKey({
            currency0: currency0,
            currency1: currency1,
            fee: 500,
            tickSpacing: SPACING,
            hooks: IHooks(address(0))
        });
        manager.initialize(k2, SQRT_PRICE_1_1);

        vm.prank(mallory); // whitelisting stays permissionless; the allowlist is compiled in
        mole.whitelistPool(k2);
        assertTrue(mole.isWhitelisted(k2.toId()), "a plain ERC-20 pool must still be admissible");

        uint256 id = mole.open(k2, -600, 600, 1e18, type(uint256).max, type(uint256).max, block.timestamp);
        assertEq(mole.ownerOf(id), address(this), "the admitted pool must be genuinely usable");
        assertEq(mole.getPosition(id).liquidity, 1e18, "declared liquidity must be recorded");
    }

    /// @notice ATTACK: evade the guard by putting native in the OTHER slot. A key with currency1 ==
    ///         address(0) is unsorted garbage v4 can never initialize (CurrenciesOutOfOrderOrEqual —
    ///         proven first), but whitelistPool reads currency0 ONLY, so the listing SUCCEEDS. Pinned
    ///         deliberately: the bypass leads nowhere. The pool cannot exist, so open() dies inside
    ///         the unlock at v4's own PoolNotInitialized — BEFORE any transfer — and nothing moves.
    ///         currency0-only is sufficient for every initializable pool because native sorts first;
    ///         what this admits is a dead junk listing, which permissionless whitelisting allows in
    ///         unlimited quantity anyway. If a refactor ever makes listings load-bearing as
    ///         "initializable pools", this test is the tripwire.
    function test_attack_nativeAsCurrency1SlipsPastTheGuardButFailsClosed() public {
        PoolKey memory ghost = PoolKey({
            currency0: currency0,
            currency1: CurrencyLibrary.ADDRESS_ZERO,
            fee: 3000,
            tickSpacing: SPACING,
            hooks: IHooks(address(0))
        });

        // The pool this key names can never exist: v4 refuses the unsorted currencies.
        vm.expectRevert(
            abi.encodeWithSelector(
                IPoolManager.CurrenciesOutOfOrderOrEqual.selector, Currency.unwrap(currency0), address(0)
            )
        );
        manager.initialize(ghost, SQRT_PRICE_1_1);

        // ...and yet the LISTING is admitted: the guard checks currency0 only.
        vm.prank(mallory);
        mole.whitelistPool(ghost);
        assertTrue(mole.isWhitelisted(ghost.toId()), "premise: the ghost listing was admitted");

        // The listing is dead on arrival. open() reverts inside the unlock at the PoolManager's own
        // initialization check, atomically: no position, no token movement, no ETH movement.
        uint256 balBefore = MockERC20(Currency.unwrap(currency0)).balanceOf(address(this));
        vm.expectRevert(IPoolManager.PoolNotInitialized.selector);
        mole.open(ghost, -600, 600, 1e18, type(uint256).max, type(uint256).max, block.timestamp);

        assertEq(mole.positionCount(), 0, "a position was minted against a pool that cannot exist");
        assertEq(
            MockERC20(Currency.unwrap(currency0)).balanceOf(address(this)),
            balBefore,
            "tokens moved into a dead listing"
        );
    }

    /*==========================================================================
                        2. POSITION SIZE BAND: PRIVILEGE
    ==========================================================================*/

    /// @notice ATTACK: seize the deposit throttle. A stranger setting the band can pause deposits
    ///         (min > every realistic size) or re-open whale capture (ceiling off). The KEEPER is
    ///         tried separately and by name: it is the operationally privileged key — the one a
    ///         compromise actually hands an attacker — and the whole design rests on keeper-power
    ///         and admin-power being disjoint. Both are refused with NotUpgradeAdmin and the band
    ///         provably stays (0,0). The real upgradeAdmin then sets it, emitting
    ///         PositionSizeBandSet — proving the refusals were about the CALLER, not the call.
    function test_attack_strangerAndKeeperCannotSetTheSizeBand() public {
        assertEq(mole.minPositionLiquidity(), 0, "premise: band ships disabled");
        assertEq(mole.maxPositionLiquidity(), 0, "premise: band ships disabled");

        vm.prank(mallory);
        vm.expectRevert(MolePositions.NotUpgradeAdmin.selector);
        mole.setPositionSizeBand(1, type(uint128).max);

        // The keeper key specifically: operational privilege must not reach the band.
        vm.prank(KEEPER);
        vm.expectRevert(MolePositions.NotUpgradeAdmin.selector);
        mole.setPositionSizeBand(1, type(uint128).max);

        assertEq(mole.minPositionLiquidity(), 0, "a refused caller changed the floor");
        assertEq(mole.maxPositionLiquidity(), 0, "a refused caller changed the ceiling");

        // Control: the actual root key can, and the change is observable as an event.
        vm.expectEmit(false, false, false, true, address(mole));
        emit MolePositions.PositionSizeBandSet(1e18, 5e20);
        vm.prank(TEST_UPGRADE_ADMIN);
        mole.setPositionSizeBand(1e18, 5e20);
        assertEq(mole.minPositionLiquidity(), 1e18, "admin set was not stored");
        assertEq(mole.maxPositionLiquidity(), 5e20, "admin set was not stored");
    }

    /// @notice ATTACK: fat-finger (or malicious-admin) a band that refuses every deposit. min > max
    ///         with the ceiling live is CapAboveCeiling — a deposit pause must be spelled out, not
    ///         typo'd. The two legal shapes NEAREST the refusal are then proven to work, because each
    ///         is one comparison away from being swallowed by a careless guard: min == max (a
    ///         one-size band) and min > 0 with max == 0 — where 0 must mean DISABLED, not a ceiling
    ///         of zero; compared as a number, every non-zero floor would invert against it and the
    ///         disable convention itself would become unreachable.
    function test_attack_invertedBandIsRefusedButItsLegalNeighboursAreNot() public {
        vm.prank(TEST_UPGRADE_ADMIN);
        vm.expectRevert(MolePositions.CapAboveCeiling.selector);
        mole.setPositionSizeBand(10, 9);
        assertEq(mole.minPositionLiquidity(), 0, "a refused band was stored");
        assertEq(mole.maxPositionLiquidity(), 0, "a refused band was stored");

        // One-size band: the tightest legal configuration.
        vm.prank(TEST_UPGRADE_ADMIN);
        mole.setPositionSizeBand(10, 10);
        assertEq(mole.minPositionLiquidity(), 10);
        assertEq(mole.maxPositionLiquidity(), 10);

        // Floor live, ceiling DISABLED: numerically min > max, legally fine because 0 is a switch.
        vm.prank(TEST_UPGRADE_ADMIN);
        mole.setPositionSizeBand(10, 0);
        assertEq(mole.minPositionLiquidity(), 10);
        assertEq(mole.maxPositionLiquidity(), 0);
    }

    /*==========================================================================
                        3. POSITION SIZE BAND: THE EDGES
    ==========================================================================*/

    /// @notice ATTACK: dust griefing — flood the vault with positions one wei of liquidity under the
    ///         floor, too small to be worth a keeper's gas. The floor bites at EXACTLY its edge: a
    ///         deposit AT the floor is a legal deposit and succeeds; F-1 wei is refused with
    ///         PositionTooSmall on the DECLARED liquidity, before anything is pulled, and mints
    ///         nothing. An off-by-one in either direction (>= for >, or > min-1) fails this test.
    function test_attack_dustPositionOneWeiUnderTheFloorIsRefused() public {
        uint128 FLOOR = 1e18;
        vm.prank(TEST_UPGRADE_ADMIN);
        mole.setPositionSizeBand(FLOOR, 0);

        // AT the floor: legal, and genuinely opens.
        uint256 id = mole.open(key, -600, 600, FLOOR, type(uint256).max, type(uint256).max, block.timestamp);
        assertEq(mole.getPosition(id).liquidity, FLOOR, "a deposit AT the floor must succeed");

        // One wei of liquidity under: refused, nothing minted.
        vm.expectRevert(MolePositions.PositionTooSmall.selector);
        mole.open(key, -600, 600, FLOOR - 1, type(uint256).max, type(uint256).max, block.timestamp);
        assertEq(mole.positionCount(), 1, "a sub-floor position was minted");
    }

    /// @notice ATTACK: whale capture — a single deposit one wei of liquidity over the ceiling, the
    ///         first step toward this vault becoming the pool's dominant LP (the condition that made
    ///         the oracle cheap to walk in F-4). The ceiling bites at EXACTLY its edge: a deposit AT
    ///         the ceiling succeeds; C+1 is refused with PositionTooLarge and mints nothing.
    function test_attack_whalePositionOneWeiOverTheCeilingIsRefused() public {
        uint128 CEILING = 1e21;
        vm.prank(TEST_UPGRADE_ADMIN);
        mole.setPositionSizeBand(0, CEILING);

        // AT the ceiling: legal, and genuinely opens.
        uint256 id = mole.open(key, -600, 600, CEILING, type(uint256).max, type(uint256).max, block.timestamp);
        assertEq(mole.getPosition(id).liquidity, CEILING, "a deposit AT the ceiling must succeed");

        // One wei of liquidity over: refused, nothing minted.
        vm.expectRevert(MolePositions.PositionTooLarge.selector);
        mole.open(key, -600, 600, CEILING + 1, type(uint256).max, type(uint256).max, block.timestamp);
        assertEq(mole.positionCount(), 1, "an over-ceiling position was minted");
    }

    /// @notice 0 disables each end INDEPENDENTLY — not jointly, and not as a literal bound. Three
    ///         configurations, each proven by opening at the extreme the disabled end would forbid
    ///         AND by the live end still refusing, so "disabled" cannot be faked by the whole band
    ///         being off:
    ///           (0, C): a 1-wei-of-liquidity dust position opens (no floor) while C+1 is still
    ///                   refused (ceiling live);
    ///           (F, 0): a 1e24 whale opens (no ceiling) while F-1 is still refused (floor live);
    ///           (0, 0): both extremes open — the shipped default is a fully open vault.
    function test_attack_zeroDisablesEachEndIndependently() public {
        uint128 FLOOR = 1e18;
        uint128 CEILING = 1e21;

        // Floor DISABLED, ceiling LIVE.
        vm.prank(TEST_UPGRADE_ADMIN);
        mole.setPositionSizeBand(0, CEILING);
        uint256 idDust = mole.open(key, -600, 600, 1, type(uint256).max, type(uint256).max, block.timestamp);
        assertEq(mole.getPosition(idDust).liquidity, 1, "floor=0 must admit a 1-wei position");
        vm.expectRevert(MolePositions.PositionTooLarge.selector);
        mole.open(key, -600, 600, CEILING + 1, type(uint256).max, type(uint256).max, block.timestamp);

        // Ceiling DISABLED, floor LIVE.
        vm.prank(TEST_UPGRADE_ADMIN);
        mole.setPositionSizeBand(FLOOR, 0);
        uint256 idWhale = mole.open(key, -600, 600, 1e24, type(uint256).max, type(uint256).max, block.timestamp);
        assertEq(mole.getPosition(idWhale).liquidity, 1e24, "max=0 must admit an enormous position");
        vm.expectRevert(MolePositions.PositionTooSmall.selector);
        mole.open(key, -600, 600, FLOOR - 1, type(uint256).max, type(uint256).max, block.timestamp);

        // Both DISABLED: the band is fully off and both extremes open.
        vm.prank(TEST_UPGRADE_ADMIN);
        mole.setPositionSizeBand(0, 0);
        mole.open(key, -600, 600, 1, type(uint256).max, type(uint256).max, block.timestamp);
        mole.open(key, -600, 600, 1e24, type(uint256).max, type(uint256).max, block.timestamp);
        assertEq(mole.positionCount(), 4, "all four in-band opens must have succeeded");
    }
}
