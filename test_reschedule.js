const axios = require("axios");

const CONFIG = {
  AUTH_URL: "https://marketplace.meevo.com/oauth2/token",
  API_URL: "https://na1pub.meevo.com/publicapi/v1",
  CLIENT_ID: "f6a5046d-208e-4829-9941-034ebdd2aa65",
  CLIENT_SECRET: "2f8feb2e-51f5-40a3-83af-3d4a6a454abe",
  TENANT_ID: "200507",
  LOCATION_ID: "201664"
};

async function test() {
  const authRes = await axios.post(CONFIG.AUTH_URL, {
    client_id: CONFIG.CLIENT_ID,
    client_secret: CONFIG.CLIENT_SECRET
  });
  const token = authRes.data.access_token;
  const clientId = "d28fd317-191f-400a-8514-ac9801234541";
  const stylistId = "49185114-423f-4c8a-a52e-b0c00129a9e8"; // Hannah

  console.log("===== STEP 1: Book fresh appointment with add-on =====");

  // Book haircut at 12:00 PM
  const bookData = new URLSearchParams({
    ServiceId: "f9160450-0b51-4ddc-bcc7-ac150103d5c0", // Haircut
    ClientId: clientId,
    ClientGender: 2035,
    StartTime: "2026-01-25T12:00:00-07:00",
    EmployeeId: stylistId
  });

  const bookRes = await axios.post(
    CONFIG.API_URL + "/book/service?TenantId=" + CONFIG.TENANT_ID + "&LocationId=" + CONFIG.LOCATION_ID,
    bookData.toString(),
    { headers: { Authorization: "Bearer " + token, "Content-Type": "application/x-www-form-urlencoded" } }
  );

  const mainAppt = bookRes.data && bookRes.data.data;
  console.log("Haircut booked at 12:00 PM, appointmentServiceId:", mainAppt.appointmentServiceId);

  // Add beard at 12:20 PM
  const addonData = new URLSearchParams({
    ServiceId: "65ee2a0d-e995-4d8d-a286-ac150106994b", // Beard
    ClientId: clientId,
    ClientGender: 2035,
    StartTime: "2026-01-25T12:20:00-07:00",
    EmployeeId: stylistId,
    AppointmentId: mainAppt.appointmentId
  });

  await axios.post(
    CONFIG.API_URL + "/book/service?TenantId=" + CONFIG.TENANT_ID + "&LocationId=" + CONFIG.LOCATION_ID,
    addonData.toString(),
    { headers: { Authorization: "Bearer " + token, "Content-Type": "application/x-www-form-urlencoded" } }
  );
  console.log("Beard add-on booked at 12:20 PM");

  // Verify initial state
  let lookupRes = await axios.get(
    CONFIG.API_URL + "/book/client/" + clientId + "/services?TenantId=" + CONFIG.TENANT_ID + "&LocationId=" + CONFIG.LOCATION_ID,
    { headers: { Authorization: "Bearer " + token } }
  );

  console.log("");
  console.log("Initial state:");
  (lookupRes.data && lookupRes.data.data || []).forEach(s => {
    const type = s.serviceId === "f9160450-0b51-4ddc-bcc7-ac150103d5c0" ? "Haircut" : "Beard";
    console.log("  " + type + ": " + s.startTime.split("T")[1].split(".")[0]);
  });

  console.log("");
  console.log("===== STEP 2: Reschedule to Jan 26 9:00 AM (date change) =====");

  const rescheduleRes = await axios.post("https://reschedule-appointment-prod-production.up.railway.app/reschedule", {
    phone: "+15093851192",
    appointment_service_id: mainAppt.appointmentServiceId,
    new_datetime: "2026-01-26T09:00:00-07:00",
    stylist: stylistId
  });

  console.log("Reschedule result:", rescheduleRes.data.success ? "SUCCESS" : "FAILED");
  console.log("Services rescheduled:", rescheduleRes.data.services_rescheduled);

  console.log("");
  console.log("===== STEP 3: Verify final state =====");

  lookupRes = await axios.get(
    CONFIG.API_URL + "/book/client/" + clientId + "/services?TenantId=" + CONFIG.TENANT_ID + "&LocationId=" + CONFIG.LOCATION_ID,
    { headers: { Authorization: "Bearer " + token } }
  );

  const services = lookupRes.data && lookupRes.data.data || [];
  console.log("Total services:", services.length);

  // Group by appointmentId
  const byAppt = {};
  services.forEach(s => {
    const apptId = s.appointmentId;
    if (byAppt[apptId] === undefined) byAppt[apptId] = [];
    byAppt[apptId].push(s);
  });

  const apptIds = Object.keys(byAppt);
  console.log("Appointments:", apptIds.length);

  apptIds.forEach(apptId => {
    const apptServices = byAppt[apptId];
    console.log("");
    console.log("Appointment " + apptId.slice(0, 8) + "...");
    apptServices.forEach(s => {
      const type = s.serviceId === "f9160450-0b51-4ddc-bcc7-ac150103d5c0" ? "Haircut" : "Beard";
      const date = s.startTime.split("T")[0];
      const time = s.startTime.split("T")[1].split(".")[0];
      console.log("  " + type + ": " + date + " " + time);
    });
  });

  // Check success criteria
  if (services.length === 2 && apptIds.length === 1) {
    const haircut = services.find(s => s.serviceId === "f9160450-0b51-4ddc-bcc7-ac150103d5c0");
    const beard = services.find(s => s.serviceId === "65ee2a0d-e995-4d8d-a286-ac150106994b");
    if (haircut && beard && haircut.appointmentId === beard.appointmentId) {
      const haircutTime = new Date(haircut.startTime);
      const beardTime = new Date(beard.startTime);
      const offsetMins = (beardTime - haircutTime) / 60000;
      console.log("");
      console.log("Offset between services:", offsetMins, "minutes");
      if (offsetMins === 20 && haircut.startTime.includes("2026-01-26")) {
        console.log("");
        console.log("==> SUCCESS! Both services moved to new date with correct 20-min offset!");
      }
    }
  }
}

test().catch(e => console.error(e.response && e.response.data || e.message));
