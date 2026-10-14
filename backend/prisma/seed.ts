import "dotenv/config";

import bcrypt from "bcrypt";
import { createDatabasePool } from "../src/database/pool.js";
import { PrismaPg } from "@prisma/adapter-pg";

import {
  AppointmentFeeType,
  DayOfWeek,
  PrismaClient,
  UserRole,
} from "../generated/prisma/client.js";

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error("DATABASE_URL is required.");
}

const pool = createDatabasePool(databaseUrl);

const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

const BCRYPT_ROUNDS = 12;

// ------------------------------------------------------------
// Environment
// ------------------------------------------------------------

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();

  if (!value) {
    throw new Error(`${name} is required for database seeding.`);
  }

  return value;
}

// ------------------------------------------------------------
// Deterministic development UUIDs
// ------------------------------------------------------------

function seedUuid(group: number, number: number): string {
  const prefix = group.toString(16).padStart(8, "0");
  const suffix = number.toString(16).padStart(12, "0");

  return `${prefix}-0000-4000-8000-${suffix}`;
}

const ADMIN_ID = seedUuid(1, 1);
const CASHIER_ID = seedUuid(1, 2);
const SALON_PROFILE_ID = seedUuid(2, 1);
const POLICY_ID = seedUuid(3, 1);

// ------------------------------------------------------------
// PostgreSQL TIME helper
// ------------------------------------------------------------

function time(hour: number, minute = 0): Date {
  return new Date(
    `1970-01-01T${hour.toString().padStart(2, "0")}:${minute
      .toString()
      .padStart(2, "0")}:00.000Z`,
  );
}

// ------------------------------------------------------------
// Approved service catalog
//
// "+" / "++" / "starts at" values from the current salon menu
// are treated as fixed MVP prices for now.
// Durations are approved initial estimates.
// null buffer means use BookingPolicyVersion.defaultBufferMinutes.
// ------------------------------------------------------------

const services = [
  {
    name: "Ladies Haircut",
    description: "Hair Services",
    price: "120.00",
    durationMinutes: 30,
  },
  {
    name: "Ladies Haircut w/ Blowdry",
    description: "Hair Services",
    price: "170.00",
    durationMinutes: 45,
  },
  {
    name: "Ladies Haircut w/ Shampoo & Conditioner + Blowdry",
    description: "Hair Services",
    price: "220.00",
    durationMinutes: 60,
  },
  {
    name: "Men's Haircut",
    description: "Hair Services",
    price: "120.00",
    durationMinutes: 30,
  },
  {
    name: "Men's Haircut w/ Blowdry & Shampoo",
    description: "Hair Services",
    price: "200.00",
    durationMinutes: 45,
  },
  {
    name: "Kids Haircut",
    description: "Hair Services",
    price: "150.00",
    durationMinutes: 30,
  },
  {
    name: "Kids Haircut w/ Blowdry",
    description: "Hair Services",
    price: "200.00",
    durationMinutes: 45,
  },
  {
    name: "Shampoo & Blow Dry",
    description: "Hair Services",
    price: "150.00",
    durationMinutes: 45,
  },
  {
    name: "Hair Iron / Curl",
    description: "Hair Services",
    price: "200.00",
    durationMinutes: 45,
  },

  {
    name: "Hair Color (Short)",
    description: "Hair Color & Styling",
    price: "500.00",
    durationMinutes: 90,
  },
  {
    name: "Hair Color (Medium)",
    description: "Hair Color & Styling",
    price: "700.00",
    durationMinutes: 120,
  },
  {
    name: "Hair Color (Long)",
    description: "Hair Color & Styling",
    price: "1000.00",
    durationMinutes: 150,
  },
  {
    name: "Highlights & Color",
    description: "Hair Color & Styling",
    price: "1500.00",
    durationMinutes: 180,
  },
  {
    name: "Balayage Package",
    description: "Hair Color & Styling",
    price: "2500.00",
    durationMinutes: 240,
  },
  {
    name: "Rebonding",
    description: "Hair Color & Styling",
    price: "1000.00",
    durationMinutes: 180,
  },
  {
    name: "Rebond with Color",
    description: "Hair Color & Styling",
    price: "1500.00",
    durationMinutes: 240,
  },
  {
    name: "Rebonding with Color & Keratin",
    description: "Hair Color & Styling",
    price: "1999.00",
    durationMinutes: 300,
  },
  {
    name: "Rebonding with Color & Brazilian",
    description: "Hair Color & Styling",
    price: "2499.00",
    durationMinutes: 300,
  },

  {
    name: "Brazilian",
    description: "Hair Treatments",
    price: "800.00",
    durationMinutes: 120,
  },
  {
    name: "Hair Spa",
    description: "Hair Treatments",
    price: "500.00",
    durationMinutes: 60,
  },
  {
    name: "Hot Oil Treatment",
    description: "Hair Treatments",
    price: "600.00",
    durationMinutes: 60,
  },
  {
    name: "Keratin Treatment",
    description: "Hair Treatments",
    price: "500.00",
    durationMinutes: 90,
  },

  {
    name: "Manicure",
    description: "Nail Services",
    price: "130.00",
    durationMinutes: 30,
  },
  {
    name: "Pedicure",
    description: "Nail Services",
    price: "130.00",
    durationMinutes: 45,
  },
  {
    name: "Manicure & Pedicure",
    description: "Nail Services",
    price: "250.00",
    durationMinutes: 75,
  },
  {
    name: "Gel Polish",
    description: "Nail Services",
    price: "350.00",
    durationMinutes: 60,
  },
  {
    name: "Nail Art",
    description: "Nail Services",
    price: "50.00",
    durationMinutes: 60,
  },
  {
    name: "Eyebrow Shaping",
    description: "Nail Services",
    price: "50.00",
    durationMinutes: 15,
  },

  {
    name: "Foot Spa",
    description: "Spa & Relaxation",
    price: "280.00",
    durationMinutes: 60,
  },
  {
    name: "Foot Spa with Pedicure",
    description: "Spa & Relaxation",
    price: "400.00",
    durationMinutes: 90,
  },
] as const;

// ------------------------------------------------------------
// Approved development staff fixtures
// ------------------------------------------------------------

type SeedServiceName = (typeof services)[number]["name"];
type SeedStaffFixture = {
  id: string; firstName: string; lastName: string;
  serviceNames: readonly SeedServiceName[]; commissionRate: string;
};
// Keep the other staff's existing development assignments until their actual
// skills are specified. Replace these lists with exact catalog service names.
const allServiceNames = services.map(service => service.name);
const staffFixtures: readonly SeedStaffFixture[] = [
  {
    id: seedUuid(4, 1),
    firstName: "Mary Grace",
    lastName: "",
    serviceNames: allServiceNames,
    commissionRate: "0.4000",
  },
  {
    id: seedUuid(4, 2),
    firstName: "Maris",
    lastName: "",
    serviceNames: allServiceNames,
    commissionRate: "0.4000",
  },
  {
    id: seedUuid(4, 3),
    firstName: "Bea",
    lastName: "",
    serviceNames: allServiceNames,
    commissionRate: "0.4000",
  },
  {
    id: seedUuid(4, 4),
    firstName: "Rose Ann",
    lastName: "",
    serviceNames: allServiceNames,
    commissionRate: "0.4000",
  },
  {
    id: seedUuid(4, 5),
    firstName: "Mildred",
    lastName: "",
    serviceNames: ["Manicure", "Pedicure", "Manicure & Pedicure", "Gel Polish", "Nail Art"],
    commissionRate: "0.4000",
  },
] as const;

const days: DayOfWeek[] = [
  DayOfWeek.MONDAY,
  DayOfWeek.TUESDAY,
  DayOfWeek.WEDNESDAY,
  DayOfWeek.THURSDAY,
  DayOfWeek.FRIDAY,
  DayOfWeek.SATURDAY,
  DayOfWeek.SUNDAY,
];

// ------------------------------------------------------------
// Main seed
// ------------------------------------------------------------

async function main() {
  if (process.env.NODE_ENV === "production") {
    throw new Error("Development seeding is disabled in production.");
  }

  console.log("Starting Clique Salon development seed...");

  const adminEmail = requireEnv("SEED_ADMIN_EMAIL").toLowerCase();
  const adminPassword = requireEnv("SEED_ADMIN_PASSWORD");

  const cashierEmail = requireEnv("SEED_CASHIER_EMAIL").toLowerCase();
  const cashierPassword = requireEnv("SEED_CASHIER_PASSWORD");

  // Hash before starting the database transaction.
  const [adminPasswordHash, cashierPasswordHash] = await Promise.all([
    bcrypt.hash(adminPassword, BCRYPT_ROUNDS),
    bcrypt.hash(cashierPassword, BCRYPT_ROUNDS),
  ]);

  await prisma.$transaction(async (tx) => {
    // --------------------------------------------------------
    // Safety guard
    //
    // Once appointments exist, configuration should be changed
    // through the application's normal protected workflows.
    // --------------------------------------------------------

    const appointmentCount = await tx.appointment.count();

    if (appointmentCount > 0) {
      throw new Error(
        "Seed aborted: appointments already exist. " +
          "Use a fresh/reset development database before re-seeding.",
      );
    }

    // --------------------------------------------------------
    // Single SalonProfile invariant
    // --------------------------------------------------------

    const otherSalonProfiles = await tx.salonProfile.count({
      where: {
        NOT: {
          id: SALON_PROFILE_ID,
        },
      },
    });

    if (otherSalonProfiles > 0) {
      throw new Error(
        "Seed aborted: another SalonProfile already exists. " +
          "The MVP supports only one salon profile.",
      );
    }

    // --------------------------------------------------------
    // Development Admin / Cashier
    // --------------------------------------------------------

    const admin = await tx.user.upsert({
      where: {
        id: ADMIN_ID,
      },
      update: {
        email: adminEmail,
        passwordHash: adminPasswordHash,
        role: UserRole.ADMIN,
        firstName: "Development",
        lastName: "Admin",
        isActive: true,
      },
      create: {
        id: ADMIN_ID,
        email: adminEmail,
        passwordHash: adminPasswordHash,
        role: UserRole.ADMIN,
        firstName: "Development",
        lastName: "Admin",
        isActive: true,
      },
    });

    await tx.user.upsert({
      where: {
        id: CASHIER_ID,
      },
      update: {
        email: cashierEmail,
        passwordHash: cashierPasswordHash,
        role: UserRole.CASHIER,
        firstName: "Development",
        lastName: "Cashier",
        isActive: true,
      },
      create: {
        id: CASHIER_ID,
        email: cashierEmail,
        passwordHash: cashierPasswordHash,
        role: UserRole.CASHIER,
        firstName: "Development",
        lastName: "Cashier",
        isActive: true,
      },
    });

    // --------------------------------------------------------
    // Salon profile
    // --------------------------------------------------------

    await tx.salonProfile.upsert({
      where: {
        id: SALON_PROFILE_ID,
      },
      update: {
        name: "Clique Salon",
        phone: "09057486436",
        email: null,
        address: "79 Geronimo St., Brgy. Bagong Silangan, Quezon City",
      },
      create: {
        id: SALON_PROFILE_ID,
        name: "Clique Salon",
        phone: "09057486436",
        email: null,
        address: "79 Geronimo St., Brgy. Bagong Silangan, Quezon City",
      },
    });

    // --------------------------------------------------------
    // Booking Policy V1
    // --------------------------------------------------------

    await tx.bookingPolicyVersion.upsert({
      where: {
        version: 1,
      },
      update: {
        appointmentFeeType: AppointmentFeeType.FIXED,
        appointmentFeeAmount: "100.00",
        bookingHoldMinutes: 10,
        defaultBufferMinutes: 15,
        maxReschedules: 2,
        rescheduleCutoffHours: 4,
        cancellationCutoffHours: 4,
        noShowGraceHours: 72,
        advanceBookingDays: 30,
        minimumBookingLeadMinutes: 60,
        effectiveFrom: new Date("2026-10-01T00:00:00+08:00"),
        createdByUserId: admin.id,
      },
      create: {
        id: POLICY_ID,
        version: 1,
        appointmentFeeType: AppointmentFeeType.FIXED,
        appointmentFeeAmount: "100.00",
        bookingHoldMinutes: 10,
        defaultBufferMinutes: 15,
        maxReschedules: 2,
        rescheduleCutoffHours: 4,
        cancellationCutoffHours: 4,
        noShowGraceHours: 72,
        advanceBookingDays: 30,
        minimumBookingLeadMinutes: 60,
        effectiveFrom: new Date("2026-10-01T00:00:00+08:00"),
        createdByUserId: admin.id,
      },
    });

    // --------------------------------------------------------
    // Salon hours — daily 08:00 to 22:00
    // --------------------------------------------------------

    for (const [index, dayOfWeek] of days.entries()) {
      const id = seedUuid(5, index + 1);

      await tx.salonOperatingHour.upsert({
        where: {
          id,
        },
        update: {
          dayOfWeek,
          openTime: time(8),
          closeTime: time(22),
          isActive: true,
        },
        create: {
          id,
          dayOfWeek,
          openTime: time(8),
          closeTime: time(22),
          isActive: true,
        },
      });
    }

    // --------------------------------------------------------
    // Services
    // --------------------------------------------------------

    const seededServices = [];

    for (const [index, service] of services.entries()) {
      const id = seedUuid(6, index + 1);

      const savedService = await tx.service.upsert({
        where: {
          id,
        },
        update: {
          name: service.name,
          description: service.description,
          category: service.description,
          price: service.price,
          durationMinutes: service.durationMinutes,
          bufferMinutes: null,
          isActive: true,
        },
        create: {
          id,
          name: service.name,
          description: service.description,
          category: service.description,
          price: service.price,
          durationMinutes: service.durationMinutes,
          bufferMinutes: null,
          isActive: true,
        },
      });

      seededServices.push(savedService);
    }

    // --------------------------------------------------------
    // Staff
    // --------------------------------------------------------

    const seededStaff = [];

    for (const fixture of staffFixtures) {
      const staff = await tx.staff.upsert({
        where: {
          id: fixture.id,
        },
        update: {
          firstName: fixture.firstName,
          lastName: fixture.lastName,
          phone: null,
          isActive: true,
        },
        create: {
          id: fixture.id,
          firstName: fixture.firstName,
          lastName: fixture.lastName,
          phone: null,
          isActive: true,
        },
      });

      seededStaff.push(staff);
    }

    // --------------------------------------------------------
    // Qualifications
    //
    // Only the services listed in each staff fixture are enabled.
    // Unlisted qualifications are deactivated when re-seeding, not deleted.
    // --------------------------------------------------------

    for (const fixture of staffFixtures) {
      const serviceNames = new Set<string>(fixture.serviceNames);
      const qualifiedServices = seededServices.filter(service => serviceNames.has(service.name));
      if (qualifiedServices.length !== serviceNames.size || fixture.serviceNames.length !== serviceNames.size) {
        throw new Error(`Unknown or duplicate catalog service names configured for ${fixture.firstName}.`);
      }
      await tx.staffService.updateMany({
        where: { staffId: fixture.id, serviceId: { notIn: qualifiedServices.map(service => service.id) }, isActive: true },
        data: { isActive: false },
      });
      for (const service of qualifiedServices) {
        await tx.staffService.upsert({
          where: {
            staffId_serviceId: {
              staffId: fixture.id,
              serviceId: service.id,
            },
          },
          update: {
            commissionRate: fixture.commissionRate,
            isActive: true,
          },
          create: {
            staffId: fixture.id,
            serviceId: service.id,
            commissionRate: fixture.commissionRate,
            isActive: true,
          },
        });
      }
    }

    // --------------------------------------------------------
    // Staff schedules
    //
    // Initial development assumption:
    // all staff work daily from 08:00 to 22:00.
    // --------------------------------------------------------

    let scheduleNumber = 1;

    for (const staff of seededStaff) {
      for (const dayOfWeek of days) {
        const id = seedUuid(7, scheduleNumber++);

        await tx.staffSchedule.upsert({
          where: {
            id,
          },
          update: {
            staffId: staff.id,
            dayOfWeek,
            startTime: time(8),
            endTime: time(22),
            effectiveFrom: null,
            effectiveTo: null,
            isActive: true,
          },
          create: {
            id,
            staffId: staff.id,
            dayOfWeek,
            startTime: time(8),
            endTime: time(22),
            effectiveFrom: null,
            effectiveTo: null,
            isActive: true,
          },
        });
      }
    }
  });

  // ----------------------------------------------------------
  // Verification counts
  // ----------------------------------------------------------

  const [
    userCount,
    salonProfileCount,
    policyCount,
    operatingHourCount,
    serviceCount,
    staffCount,
    qualificationCount,
    staffScheduleCount,
  ] = await Promise.all([
    prisma.user.count(),
    prisma.salonProfile.count(),
    prisma.bookingPolicyVersion.count(),
    prisma.salonOperatingHour.count(),
    prisma.service.count(),
    prisma.staff.count(),
    prisma.staffService.count(),
    prisma.staffSchedule.count(),
  ]);

  console.log("Development seed completed.");
  console.log({
    users: userCount,
    salonProfiles: salonProfileCount,
    bookingPolicies: policyCount,
    operatingHours: operatingHourCount,
    services: serviceCount,
    staff: staffCount,
    staffServiceQualifications: qualificationCount,
    staffSchedules: staffScheduleCount,
  });
}

main()
  .catch((error) => {
    console.error("Database seed failed:");
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
    await pool.end();
  });
