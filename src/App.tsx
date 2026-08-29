import { Route, Routes } from "react-router-dom";
import Home from "./routes/Home";
import AdminLogin from "./routes/AdminLogin";
import Admin from "./routes/Admin";
import OperatorLogin from "./routes/OperatorLogin";
import Booth from "./routes/Booth";
import Queue from "./routes/Queue";
import Wall from "./routes/Wall";
import WallLed from "./routes/WallLed";
import WallLightbox from "./routes/WallLightbox";
import Guest from "./routes/Guest";
import GuestEvent from "./routes/GuestEvent";
import QrKit from "./routes/QrKit";
import Control from "./routes/Control";
import War from "./routes/War";
import Kiosk from "./routes/Kiosk";
import Shirt from "./routes/Shirt";
import Avatar from "./routes/Avatar";
import NotFound from "./routes/NotFound";

/** Role-based routes, one PWA. Each station opens the URL for its job and installs it. */
export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/admin/login" element={<AdminLogin />} />
      <Route path="/admin" element={<Admin />} />
      <Route path="/operator/login" element={<OperatorLogin />} />
      <Route path="/booth" element={<Booth />} />
      <Route path="/queue" element={<Queue />} />
      <Route path="/wall/:slug" element={<Wall />} />
      <Route path="/wall/:slug/led" element={<WallLed />} />
      <Route path="/wall/:slug/lightbox" element={<WallLightbox />} />
      <Route path="/guest" element={<Guest />} />
      <Route path="/g/:slug" element={<GuestEvent />} />
      <Route path="/qr/:slug" element={<QrKit />} />
      <Route path="/control" element={<Control />} />
      <Route path="/war" element={<War />} />
      <Route path="/kiosk" element={<Kiosk />} />
      <Route path="/shirt" element={<Shirt />} />
      <Route path="/avatar" element={<Avatar />} />
      <Route path="*" element={<NotFound />} />
    </Routes>
  );
}
