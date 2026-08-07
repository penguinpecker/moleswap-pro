// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IERC20 {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

interface IWPC {
    function deposit() external payable;
    function withdraw(uint256 amount) external;
}

interface ISwapRouter {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }
    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256 amountOut);
}

contract MoleSwapFeeRouter {
    address public owner;
    address public treasury;
    address public immutable swapRouter;
    address public immutable wpc;

    uint256 public feeBps;
    uint256 public constant MAX_FEE_BPS = 500;
    uint256 public constant BPS_DENOMINATOR = 10000;

    event SwapWithFee(
        address indexed user,
        address indexed tokenIn,
        address indexed tokenOut,
        uint256 amountIn,
        uint256 fee,
        uint256 amountOut
    );
    event FeeUpdated(uint256 oldFee, uint256 newFee);
    event TreasuryUpdated(address oldTreasury, address newTreasury);
    event OwnerUpdated(address oldOwner, address newOwner);

    modifier onlyOwner() {
        require(msg.sender == owner, "NOT_OWNER");
        _;
    }

    constructor(
        address _swapRouter,
        address _wpc,
        address _treasury,
        uint256 _feeBps
    ) {
        require(_swapRouter != address(0), "ZERO_ROUTER");
        require(_wpc != address(0), "ZERO_WPC");
        require(_treasury != address(0), "ZERO_TREASURY");
        require(_feeBps <= MAX_FEE_BPS, "FEE_TOO_HIGH");
        swapRouter = _swapRouter;
        wpc = _wpc;
        treasury = _treasury;
        feeBps = _feeBps;
        owner = msg.sender;
    }

    function swapExactInputSingle(
        address tokenIn,
        address tokenOut,
        uint24 poolFee,
        uint256 amountIn,
        uint256 amountOutMinimum,
        uint256 deadline,
        uint160 sqrtPriceLimitX96
    ) external payable returns (uint256 amountOut) {
        if (msg.value > 0) {
            require(tokenIn == wpc, "INVALID_NATIVE_SWAP");
            amountIn = msg.value;
            IWPC(wpc).deposit{value: amountIn}();
        } else {
            IERC20(tokenIn).transferFrom(msg.sender, address(this), amountIn);
        }

        uint256 fee = (amountIn * feeBps) / BPS_DENOMINATOR;
        uint256 amountAfterFee = amountIn - fee;

        if (fee > 0) {
            IERC20(tokenIn).transfer(treasury, fee);
        }

        IERC20(tokenIn).approve(swapRouter, amountAfterFee);

        amountOut = ISwapRouter(swapRouter).exactInputSingle(
            ISwapRouter.ExactInputSingleParams({
                tokenIn: tokenIn,
                tokenOut: tokenOut,
                fee: poolFee,
                recipient: msg.sender,
                deadline: deadline,
                amountIn: amountAfterFee,
                amountOutMinimum: amountOutMinimum,
                sqrtPriceLimitX96: sqrtPriceLimitX96
            })
        );

        emit SwapWithFee(msg.sender, tokenIn, tokenOut, amountIn, fee, amountOut);
    }

    function swapNativeOutput(
        address tokenIn,
        uint24 poolFee,
        uint256 amountIn,
        uint256 amountOutMinimum,
        uint256 deadline,
        uint160 sqrtPriceLimitX96
    ) external returns (uint256 amountOut) {
        IERC20(tokenIn).transferFrom(msg.sender, address(this), amountIn);

        uint256 fee = (amountIn * feeBps) / BPS_DENOMINATOR;
        uint256 amountAfterFee = amountIn - fee;

        if (fee > 0) {
            IERC20(tokenIn).transfer(treasury, fee);
        }

        IERC20(tokenIn).approve(swapRouter, amountAfterFee);

        amountOut = ISwapRouter(swapRouter).exactInputSingle(
            ISwapRouter.ExactInputSingleParams({
                tokenIn: tokenIn,
                tokenOut: wpc,
                fee: poolFee,
                recipient: address(this),
                deadline: deadline,
                amountIn: amountAfterFee,
                amountOutMinimum: amountOutMinimum,
                sqrtPriceLimitX96: sqrtPriceLimitX96
            })
        );

        IWPC(wpc).withdraw(amountOut);
        (bool sent, ) = payable(msg.sender).call{value: amountOut}("");
        require(sent, "PC_TRANSFER_FAILED");

        emit SwapWithFee(msg.sender, tokenIn, wpc, amountIn, fee, amountOut);
    }

    function setFee(uint256 _feeBps) external onlyOwner {
        require(_feeBps <= MAX_FEE_BPS, "FEE_TOO_HIGH");
        emit FeeUpdated(feeBps, _feeBps);
        feeBps = _feeBps;
    }

    function setTreasury(address _treasury) external onlyOwner {
        require(_treasury != address(0), "ZERO_TREASURY");
        emit TreasuryUpdated(treasury, _treasury);
        treasury = _treasury;
    }

    function setOwner(address _newOwner) external onlyOwner {
        require(_newOwner != address(0), "ZERO_OWNER");
        emit OwnerUpdated(owner, _newOwner);
        owner = _newOwner;
    }

    function rescueTokens(address token, uint256 amount) external onlyOwner {
        IERC20(token).transfer(owner, amount);
    }

    function rescueETH() external onlyOwner {
        (bool sent, ) = payable(owner).call{value: address(this).balance}("");
        require(sent, "TRANSFER_FAILED");
    }

    receive() external payable {}
}
