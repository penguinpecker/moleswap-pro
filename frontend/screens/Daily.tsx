"use client";
import Image from "next/image";
import React from "react";
import { NavBar } from "./shared";

const DailyPage = () => {
  return (
    <div className="relative flex min-h-screen w-full flex-col items-center gap-4">
      <BackgroundImage />

      <div className="relative z-50 mx-auto mt-2 block w-full px-2 sm:mt-4 sm:px-4">
        <NavBar />
      </div>
      <div className="relative z-20 flex w-full flex-1">
        <QuestCardComponent />
      </div>
    </div>
  );
};

export default DailyPage;

const BackgroundImage = () => {
  return (
    <>
      {/* Gradient Sky Layers */}
      <div className="fixed inset-0 flex h-[40vh] flex-col">
        <div className="h-[25%] bg-[#39BBE3]"></div>
        <div className="h-[25%] bg-[#6ED2F0]"></div>
        <div className="h-[25%] bg-[#AEE5F5]"></div>
        <div className="h-[25%] bg-[#E9F9FE]"></div>
      </div>
      <div className="fixed inset-0 z-10 max-md:hidden">
        {/* clouds right top  */}
        <Image
          src="/profile/c2.png"
          alt="Profile"
          width={200}
          height={200}
          className="absolute top-5 right-25 w-[200px] object-cover"
        />
        {/* clouds Center  */}
        <Image
          src="/profile/c3.png"
          alt="Profile"
          width={200}
          height={200}
          className="absolute top-[10%] left-[40%] w-[200px] object-cover"
        />
        {/* cloud left  */}
        <Image
          src="/profile/c1.png"
          alt="Profile"
          width={200}
          height={200}
          className="absolute top-0 w-[200px] object-cover"
        />
      </div>
      {/*   GRASS  */}
      <Image
        src="/profile/Grass.png"
        alt="Profile"
        width={200}
        height={200}
        className="fixed bottom-[44vh] z-10 h-full max-h-[25vh] w-full max-lg:object-cover"
      />
      {/*   BRICK */}
      <Image
        src="/profile/profile-brick.png"
        alt="Profile"
        width={200}
        height={200}
        className="fixed bottom-0 h-full max-h-[60vh] w-full object-cover"
      />
    </>
  );
};

export const QuestCardComponent = () => {
  return (
    <div className="mx-auto flex w-full max-w-5xl flex-1 flex-col px-2 sm:p-6">
      {/* Header */}
      {/* <div className="relative top-[40px] z-10 mx-auto w-[75%] rounded-lg px-6 py-4 text-center">
        <h1 className="text-peach-300 font-family-ThaleahFat text-3xl font-bold tracking-widest uppercase sm:text-5xl">
          Welcome to Daily Wheel
        </h1>
        <Image
          src="/quest/header-quest-bg.png"
          alt="Profile"
          width={200}
          height={200}
          className="absolute inset-0 left-0 z-[-1] h-full w-full"
        />
      </div> */}
      {/* Mole + Wheel container */}
      <div className="relative z-10 flex items-center justify-center">
        {/* Wheel image */}
        <div className="relative">
          {/* Mole image */}
          <Image
            src="/daily/pointing-mole.svg"
            alt="Pointing Mole"
            width={200}
            height={200}
            className="absolute top-[15%] -left-[40%] object-contain"
          />
          <Image
            src="/daily/wheel.svg"
            alt="Spin Wheel"
            width={280}
            height={280}
            className="object-contain"
          />
        </div>
      </div>
    </div>
  );
};
