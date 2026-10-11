import { redirect } from "next/navigation";

/** The portal has three sections: Games, Advertising, Revenue. */
export default function Home() {
  redirect("/games");
}
